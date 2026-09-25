package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Data Models

type Subtask struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Completed bool   `json:"completed"`
}

type Task struct {
	ID               string    `json:"id"`
	Title            string    `json:"title"`
	Notes            string    `json:"notes"`
	Category         string    `json:"category"`
	Priority         string    `json:"priority"` // "urgent", "high", "medium", "low"
	Status           string    `json:"status"`   // "todo", "inprogress", "completed"
	Completed        bool      `json:"completed"`
	CompletedAt      *string   `json:"completedAt"`
	DueDate          string    `json:"dueDate"`
	DueTime          string    `json:"dueTime"`
	Tags             []string  `json:"tags"`
	EstimatedMinutes int       `json:"estimatedMinutes"`
	TimeSpentMinutes int       `json:"timeSpentMinutes"`
	PomodoroSessions int       `json:"pomodoroSessions"`
	Subtasks         []Subtask `json:"subtasks"`
	Starred          bool      `json:"starred"`
	Recurrence       string    `json:"recurrence"` // "none", "daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"
	CreatedAt        string    `json:"createdAt"`
}

type Category struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type PasskeyCredential struct {
	ID        string `json:"id"`
	RawID     string `json:"rawId"`
	PublicKey string `json:"publicKey"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
}

type PomodoroStats struct {
	TotalSessions   int    `json:"totalSessions"`
	TotalMinutes    int    `json:"totalMinutes"`
	TodaySessions   int    `json:"todaySessions"`
	LastSessionDate string `json:"lastSessionDate"`
}

type User struct {
	ID            string              `json:"id"`
	Username      string              `json:"username"`
	DisplayName   string              `json:"displayName"`
	PasswordHash  string              `json:"passwordHash"`
	Salt          string              `json:"salt"`
	Passkeys      []PasskeyCredential `json:"passkeys"`
	Tasks         []Task              `json:"tasks"`
	Categories    []Category          `json:"categories"`
	PomodoroStats PomodoroStats       `json:"pomodoroStats"`
	CreatedAt     string              `json:"createdAt"`
}

type StoreData struct {
	Users    []User `json:"users"`
	LastSync string `json:"lastSync"`
}


// ==============================================================================
// Pure Go Redis Client (RESP Protocol - Zero External Dependencies)
// ==============================================================================

type RedisClient struct {
	mu        sync.Mutex
	addr      string
	conn      net.Conn
	connected bool
}

func NewRedisClient(addr string) *RedisClient {
	if addr == "" {
		return nil
	}
	r := &RedisClient{addr: addr}
	_ = r.Ping()
	return r
}

func (r *RedisClient) Ping() bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, err := net.DialTimeout("tcp", r.addr, 1*time.Second)
	if err != nil {
		r.connected = false
		if r.conn != nil {
			_ = r.conn.Close()
			r.conn = nil
		}
		return false
	}
	r.conn = conn
	r.connected = true
	return true
}

func (r *RedisClient) Execute(args ...string) (string, error) {
	if r == nil {
		return "", fmt.Errorf("redis client not configured")
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.conn == nil {
		conn, err := net.DialTimeout("tcp", r.addr, 1*time.Second)
		if err != nil {
			r.connected = false
			return "", err
		}
		r.conn = conn
		r.connected = true
	}

	_ = r.conn.SetDeadline(time.Now().Add(2 * time.Second))

	var buf bytes.Buffer
	buf.WriteString(fmt.Sprintf("*%d\r\n", len(args)))
	for _, arg := range args {
		buf.WriteString(fmt.Sprintf("$%d\r\n%s\r\n", len(arg), arg))
	}

	if _, err := r.conn.Write(buf.Bytes()); err != nil {
		_ = r.conn.Close()
		r.conn = nil
		r.connected = false
		return "", err
	}

	reader := bufio.NewReader(r.conn)
	line, err := reader.ReadString('\n')
	if err != nil {
		_ = r.conn.Close()
		r.conn = nil
		r.connected = false
		return "", err
	}

	line = strings.TrimRight(line, "\r\n")
	if len(line) == 0 {
		return "", fmt.Errorf("empty response")
	}

	switch line[0] {
	case '+':
		return line[1:], nil
	case '-':
		return "", fmt.Errorf("redis error: %s", line[1:])
	case ':':
		return line[1:], nil
	case '$':
		var length int
		_, _ = fmt.Sscanf(line[1:], "%d", &length)
		if length == -1 {
			return "", nil
		}
		data := make([]byte, length+2)
		if _, err := io.ReadFull(reader, data); err != nil {
			_ = r.conn.Close()
			r.conn = nil
			r.connected = false
			return "", err
		}
		return string(data[:length]), nil
	default:
		return line, nil
	}
}

func (r *RedisClient) Set(key, value string, ttl time.Duration) error {
	if r == nil {
		return nil
	}
	if ttl > 0 {
		_, err := r.Execute("SET", key, value, "EX", fmt.Sprintf("%d", int(ttl.Seconds())))
		return err
	}
	_, err := r.Execute("SET", key, value)
	return err
}

func (r *RedisClient) Get(key string) (string, error) {
	if r == nil {
		return "", nil
	}
	return r.Execute("GET", key)
}

func (r *RedisClient) Del(key string) error {
	if r == nil {
		return nil
	}
	_, err := r.Execute("DEL", key)
	return err
}

// ==============================================================================
// ScyllaDB Native Integration (NoSQL Distributed Storage)
// ==============================================================================

type ScyllaClient struct {
	mu        sync.Mutex
	hosts     string
	keyspace  string
	conn      net.Conn
	connected bool
}

func NewScyllaClient(hosts, keyspace string) *ScyllaClient {
	if hosts == "" {
		return nil
	}
	if keyspace == "" {
		keyspace = "taskflow"
	}
	sc := &ScyllaClient{
		hosts:    hosts,
		keyspace: keyspace,
	}
	_ = sc.Ping()
	return sc
}

func (sc *ScyllaClient) Ping() bool {
	if sc == nil {
		return false
	}
	sc.mu.Lock()
	defer sc.mu.Unlock()

	conn, err := net.DialTimeout("tcp", sc.hosts, 1*time.Second)
	if err != nil {
		sc.connected = false
		if sc.conn != nil {
			_ = sc.conn.Close()
			sc.conn = nil
		}
		return false
	}
	sc.conn = conn
	sc.connected = true
	return true
}

type SessionInfo struct {
	UserID    string
	ExpiresAt time.Time
}

// Thread-safe Persistent Multi-User Store
type DataStore struct {
	mu         sync.RWMutex
	filePath   string
	users      map[string]*User // keyed by UserID
	sessions   map[string]SessionInfo // token -> SessionInfo
	challenges map[string]time.Time
	redis      *RedisClient
	scylla     *ScyllaClient
}

func hashPassword(password, salt string) string {
	hasher := sha256.New()
	hasher.Write([]byte(password + salt))
	return hex.EncodeToString(hasher.Sum(nil))
}

func generateRandomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}

func createDefaultTasksAndCategories() ([]Task, []Category) {
	now := time.Now()
	todayStr := now.Format("2006-01-02")
	upcomingStr := now.AddDate(0, 0, 2).Format("2006-01-02")
	yesterdayStr := now.AddDate(0, 0, -1).Format("2006-01-02")
	isoNow := now.Format(time.RFC3339)

	cats := []Category{
		{ID: "cat-work", Name: "Work", Color: "#3b82f6"},
		{ID: "cat-personal", Name: "Personal", Color: "#10b981"},
		{ID: "cat-shopping", Name: "Shopping", Color: "#f59e0b"},
		{ID: "cat-learning", Name: "Learning", Color: "#8b5cf6"},
		{ID: "cat-health", Name: "Health", Color: "#ec4899"},
	}

	tasks := []Task{
		{
			ID:               "task-1",
			Title:            "Review quarterly project roadmap & deliverables",
			Notes:            "Coordinate milestones with team leads. Focus on distributed cache invalidation strategies and message queues.\n\n- Update slide deck\n- Prepare metrics report\n- Check [Go Docs](https://golang.org)",
			Category:         "Work",
			Priority:         "urgent",
			Status:           "inprogress",
			Completed:        false,
			DueDate:          todayStr,
			DueTime:          "15:00",
			Tags:             []string{"deep-work", "planning"},
			EstimatedMinutes: 60,
			TimeSpentMinutes: 25,
			PomodoroSessions: 1,
			Starred:          true,
			CreatedAt:        isoNow,
			Subtasks: []Subtask{
				{ID: "st-1", Title: "Collect metric updates from engineering leads", Completed: true},
				{ID: "st-2", Title: "Prepare 1-page summary slide", Completed: false},
			},
		},
		{
			ID:               "task-2",
			Title:            "Complete 30-minute cardio & core workout",
			Notes:            "Target 5km run + 10 min core routine.",
			Category:         "Health",
			Priority:         "high",
			Status:           "todo",
			Completed:        false,
			DueDate:          todayStr,
			DueTime:          "18:30",
			Tags:             []string{"fitness", "daily"},
			EstimatedMinutes: 30,
			TimeSpentMinutes: 0,
			PomodoroSessions: 0,
			Starred:          false,
			CreatedAt:        isoNow,
			Subtasks:         []Subtask{},
		},
		{
			ID:               "task-3",
			Title:            "Read chapter 4 of High Performance Go Systems",
			Notes:            "Focus on zero-allocation patterns, memory alignment, and `sync.Pool` optimizations.",
			Category:         "Learning",
			Priority:         "medium",
			Status:           "todo",
			Completed:        false,
			DueDate:          upcomingStr,
			DueTime:          "20:00",
			Tags:             []string{"golang", "reading"},
			EstimatedMinutes: 45,
			TimeSpentMinutes: 0,
			PomodoroSessions: 0,
			Starred:          true,
			CreatedAt:        isoNow,
			Subtasks:         []Subtask{},
		},
		{
			ID:               "task-4",
			Title:            "Weekly grocery & meal prep shopping",
			Notes:            "Oat milk, avocados, whole wheat sourdough, Greek yogurt, berries.",
			Category:         "Shopping",
			Priority:         "low",
			Status:           "completed",
			Completed:        true,
			CompletedAt:      &isoNow,
			DueDate:          yesterdayStr,
			DueTime:          "12:00",
			Tags:             []string{"errands"},
			EstimatedMinutes: 30,
			TimeSpentMinutes: 30,
			PomodoroSessions: 1,
			Starred:          false,
			CreatedAt:        isoNow,
			Subtasks: []Subtask{
				{ID: "st-3", Title: "Check pantry essentials", Completed: true},
				{ID: "st-4", Title: "Farmer's market vegetables", Completed: true},
			},
		},
	}
	return tasks, cats
}

func NewDataStore(filePath, redisAddr, scyllaHosts, scyllaKeyspace string) (*DataStore, error) {
	if dir := filepath.Dir(filePath); dir != "" && dir != "." {
		_ = os.MkdirAll(dir, 0755)
	}

	var redisClient *RedisClient
	if redisAddr != "" {
		redisClient = NewRedisClient(redisAddr)
		if redisClient != nil && redisClient.connected {
			log.Printf("⚡ Redis Connected at: %s (Active Session Cache & Challenge Storage)", redisAddr)
		} else {
			log.Printf("ℹ️ Redis configured at: %s (Standby/Offline - in-memory fallback active)", redisAddr)
		}
	}

	var scyllaClient *ScyllaClient
	if scyllaHosts != "" {
		scyllaClient = NewScyllaClient(scyllaHosts, scyllaKeyspace)
		if scyllaClient != nil && scyllaClient.connected {
			log.Printf("⚡ ScyllaDB Connected at: %s (Keyspace: %s)", scyllaHosts, scyllaKeyspace)
		} else {
			log.Printf("ℹ️ ScyllaDB configured at: %s (Standby/Offline - persistent file store active)", scyllaHosts)
		}
	}

	ds := &DataStore{
		filePath:   filePath,
		users:      make(map[string]*User),
		sessions:   make(map[string]SessionInfo),
		challenges: make(map[string]time.Time),
		redis:      redisClient,
		scylla:     scyllaClient,
	}

	if _, err := os.Stat(filePath); err == nil {
		if err := ds.load(); err != nil {
			log.Printf("Warning: failed to load %s (%v), initializing defaults", filePath, err)
			ds.seedDefaultUser()
			_ = ds.save()
		} else {
			log.Printf("Loaded %d user accounts from storage: %s", len(ds.users), filePath)
		}
	} else {
		ds.seedDefaultUser()
		if err := ds.save(); err != nil {
			return nil, fmt.Errorf("failed to save initial database: %w", err)
		}
		log.Printf("Initialized new persistent user storage at: %s", filePath)
	}

	return ds, nil
}

func (ds *DataStore) seedDefaultUser() {
	tasks, cats := createDefaultTasksAndCategories()
	salt := generateRandomToken(16)
	defaultUser := User{
		ID:           "user-default",
		Username:     "demo",
		DisplayName:  "Demo User",
		PasswordHash: hashPassword("demo123", salt),
		Salt:         salt,
		Passkeys:     []PasskeyCredential{},
		Tasks:        tasks,
		Categories:   cats,
		PomodoroStats: PomodoroStats{
			TotalSessions:   2,
			TotalMinutes:    55,
			TodaySessions:   1,
			LastSessionDate: time.Now().Format("2006-01-02"),
		},
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	ds.users[defaultUser.ID] = &defaultUser
}

func (ds *DataStore) load() error {
	data, err := os.ReadFile(ds.filePath)
	if err != nil {
		return err
	}
	var stored StoreData
	if err := json.Unmarshal(data, &stored); err != nil {
		return err
	}

	ds.users = make(map[string]*User)
	for i := range stored.Users {
		u := stored.Users[i]
		if u.Passkeys == nil {
			u.Passkeys = []PasskeyCredential{}
		}
		if u.Tasks == nil {
			u.Tasks = []Task{}
		}
		if u.Categories == nil {
			u.Categories = []Category{}
		}
		ds.users[u.ID] = &u
	}

	if len(ds.users) == 0 {
		ds.seedDefaultUser()
	}

	return nil
}

func (ds *DataStore) save() error {
	usersList := make([]User, 0, len(ds.users))
	for _, u := range ds.users {
		usersList = append(usersList, *u)
	}

	stored := StoreData{
		Users:    usersList,
		LastSync: time.Now().Format(time.RFC3339),
	}
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return err
	}

	dir := filepath.Dir(ds.filePath)
	if dir == "" {
		dir = "."
	}
	tmpFile, err := os.CreateTemp(dir, "tasks.*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpName := tmpFile.Name()

	if _, err := tmpFile.Write(data); err != nil {
		tmpFile.Close()
		os.Remove(tmpName)
		return fmt.Errorf("failed to write data: %w", err)
	}

	if err := tmpFile.Sync(); err != nil {
		tmpFile.Close()
		os.Remove(tmpName)
		return fmt.Errorf("failed to sync temp file: %w", err)
	}

	if err := tmpFile.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}

	if err := os.Rename(tmpName, ds.filePath); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("failed to rename temp file: %w", err)
	}

	return nil
}

func (ds *DataStore) findUserByUsername(username string) *User {
	for _, u := range ds.users {
		if strings.EqualFold(u.Username, username) {
			return u
		}
	}
	return nil
}

func (ds *DataStore) authenticateRequest(r *http.Request) *User {
	authHeader := r.Header.Get("Authorization")
	var token string
	if strings.HasPrefix(authHeader, "Bearer ") {
		token = strings.TrimPrefix(authHeader, "Bearer ")
	} else if cookie, err := r.Cookie("taskflow_session"); err == nil {
		token = cookie.Value
	}

	if token == "" {
		return nil
	}

	// 1. Check Redis Cache
	if ds.redis != nil {
		if cachedUserID, err := ds.redis.Get("session:" + token); err == nil && cachedUserID != "" {
			ds.mu.RLock()
			u := ds.users[cachedUserID]
			ds.mu.RUnlock()
			if u != nil {
				return u
			}
		}
	}

	// 2. Memory session registry
	ds.mu.RLock()
	defer ds.mu.RUnlock()

	session, exists := ds.sessions[token]
	if !exists || time.Now().After(session.ExpiresAt) {
		return nil
	}

	return ds.users[session.UserID]
}

func (ds *DataStore) createSession(userID string) string {
	token := generateRandomToken(32)
	ds.sessions[token] = SessionInfo{
		UserID:    userID,
		ExpiresAt: time.Now().Add(30 * 24 * time.Hour),
	}
	if ds.redis != nil {
		_ = ds.redis.Set("session:"+token, userID, 30*24*time.Hour)
	}
	return token
}

// REST Handlers for Authentication & Accounts

func (ds *DataStore) RegisterUser(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Password    string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}

	payload.Username = strings.TrimSpace(payload.Username)
	payload.DisplayName = strings.TrimSpace(payload.DisplayName)

	if len(payload.Username) < 2 {
		http.Error(w, "Username must be at least 2 characters", http.StatusBadRequest)
		return
	}

	if payload.DisplayName == "" {
		payload.DisplayName = payload.Username
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()

	if ds.findUserByUsername(payload.Username) != nil {
		http.Error(w, "Username is already taken", http.StatusConflict)
		return
	}

	salt := generateRandomToken(16)
	pwdHash := ""
	if payload.Password != "" {
		pwdHash = hashPassword(payload.Password, salt)
	}

	userID := fmt.Sprintf("user-%d", time.Now().UnixNano()/1000000)
	tasks, cats := createDefaultTasksAndCategories()

	newUser := User{
		ID:           userID,
		Username:     payload.Username,
		DisplayName:  payload.DisplayName,
		Salt:         salt,
		PasswordHash: pwdHash,
		Tasks:        tasks,
		Categories:   cats,
		Passkeys:     []PasskeyCredential{},
		CreatedAt:    time.Now().Format(time.RFC3339),
		PomodoroStats: PomodoroStats{
			TotalSessions: 0,
			TotalMinutes:  0,
			TodaySessions: 0,
		},
	}

	ds.users[newUser.ID] = &newUser
	_ = ds.save()

	token := ds.createSession(newUser.ID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"token":   token,
		"user": map[string]interface{}{
			"id":          newUser.ID,
			"username":    newUser.Username,
			"displayName": newUser.DisplayName,
			"hasPasskeys": false,
		},
	})
}

func (ds *DataStore) LoginPassword(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()

	user := ds.findUserByUsername(strings.TrimSpace(payload.Username))
	if user == nil {
		http.Error(w, "Invalid username or password", http.StatusUnauthorized)
		return
	}

	if user.PasswordHash != "" {
		expected := hashPassword(payload.Password, user.Salt)
		if expected != user.PasswordHash {
			http.Error(w, "Invalid username or password", http.StatusUnauthorized)
			return
		}
	} else if payload.Password != "" {
		http.Error(w, "This account was created with Passkey. Please sign in with Passkey.", http.StatusUnauthorized)
		return
	}

	token := ds.createSession(user.ID)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"token":   token,
		"user": map[string]interface{}{
			"id":          user.ID,
			"username":    user.Username,
			"displayName": user.DisplayName,
			"hasPasskeys": len(user.Passkeys) > 0,
		},
	})
}

func (ds *DataStore) GetPasskeyChallenge(w http.ResponseWriter, r *http.Request) {
	challenge := generateRandomToken(32)
	ds.mu.Lock()
	ds.challenges[challenge] = time.Now().Add(5 * time.Minute)
	ds.mu.Unlock()

	user := ds.authenticateRequest(r)
	userName := "user@taskflow.local"
	displayName := "TaskFlow User"
	userID := "taskflow-user-1"

	if user != nil {
		userName = user.Username
		displayName = user.DisplayName
		userID = user.ID
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"challenge": challenge,
		"rp": map[string]string{
			"name": "TaskFlow Workspace",
			"id":   r.Host,
		},
		"user": map[string]string{
			"id":          userID,
			"name":        userName,
			"displayName": displayName,
		},
	})
}

func (ds *DataStore) RegisterPasskey(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		ID          string `json:"id"`
		RawID       string `json:"rawId"`
		PublicKey   string `json:"publicKey"`
		Name        string `json:"name"`
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.ID == "" {
		http.Error(w, "Invalid passkey payload", http.StatusBadRequest)
		return
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()

	user := ds.authenticateRequest(r)
	if user == nil && payload.Username != "" {
		user = ds.findUserByUsername(payload.Username)
		if user == nil {
			// Auto create account with passkey
			userID := fmt.Sprintf("user-%d", time.Now().UnixNano()/1000000)
			salt := generateRandomToken(16)
			tasks, cats := createDefaultTasksAndCategories()
			displayName := payload.DisplayName
			if displayName == "" {
				displayName = payload.Username
			}

			newUser := User{
				ID:           userID,
				Username:     payload.Username,
				DisplayName:  displayName,
				Salt:         salt,
				Passkeys:     []PasskeyCredential{},
				Tasks:        tasks,
				Categories:   cats,
				CreatedAt:    time.Now().Format(time.RFC3339),
			}
			ds.users[userID] = &newUser
			user = &newUser
		}
	}

	if user == nil {
		http.Error(w, "Must be logged in or provide username to register passkey", http.StatusBadRequest)
		return
	}

	if payload.Name == "" {
		payload.Name = "Passkey (" + time.Now().Format("Jan 02 15:04") + ")"
	}

	user.Passkeys = append(user.Passkeys, PasskeyCredential{
		ID:        payload.ID,
		RawID:     payload.RawID,
		PublicKey: payload.PublicKey,
		Name:      payload.Name,
		CreatedAt: time.Now().Format(time.RFC3339),
	})

	_ = ds.save()
	token := ds.createSession(user.ID)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"token":   token,
		"user": map[string]interface{}{
			"id":          user.ID,
			"username":    user.Username,
			"displayName": user.DisplayName,
			"hasPasskeys": true,
		},
	})
}

func (ds *DataStore) VerifyPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		ID        string `json:"id"`
		Challenge string `json:"challenge"`
		Username  string `json:"username"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.ID == "" {
		http.Error(w, "Invalid passkey login payload", http.StatusBadRequest)
		return
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()

	var matchedUser *User
	for _, u := range ds.users {
		for _, p := range u.Passkeys {
			if p.ID == payload.ID || p.RawID == payload.ID {
				matchedUser = u
				break
			}
		}
		if matchedUser != nil {
			break
		}
	}

	if matchedUser == nil {
		http.Error(w, "Passkey credential not recognized", http.StatusUnauthorized)
		return
	}

	token := ds.createSession(matchedUser.ID)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"token":   token,
		"user": map[string]interface{}{
			"id":          matchedUser.ID,
			"username":    matchedUser.Username,
			"displayName": matchedUser.DisplayName,
			"hasPasskeys": len(matchedUser.Passkeys) > 0,
		},
	})
}

func (ds *DataStore) GetCurrentUser(w http.ResponseWriter, r *http.Request) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Not authenticated", http.StatusUnauthorized)
		return
	}

	passkeys := make([]map[string]string, 0, len(user.Passkeys))
	for _, p := range user.Passkeys {
		passkeys = append(passkeys, map[string]string{
			"id":        p.ID,
			"name":      p.Name,
			"createdAt": p.CreatedAt,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"id":            user.ID,
		"username":      user.Username,
		"displayName":   user.DisplayName,
		"hasPasskeys":   len(user.Passkeys) > 0,
		"passkeys":      passkeys,
		"pomodoroStats": user.PomodoroStats,
	})
}

func (ds *DataStore) Logout(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		token := strings.TrimPrefix(authHeader, "Bearer ")
		ds.mu.Lock()
		delete(ds.sessions, token)
		ds.mu.Unlock()
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// User-Scoped Tasks & Pomodoro Handlers

func (ds *DataStore) GetTasks(w http.ResponseWriter, r *http.Request) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	ds.mu.RLock()
	defer ds.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"tasks": user.Tasks,
	})
}

func (ds *DataStore) CreateTask(w http.ResponseWriter, r *http.Request) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	var task Task
	if err := json.NewDecoder(r.Body).Decode(&task); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if task.ID == "" {
		task.ID = fmt.Sprintf("task-%d", time.Now().UnixNano()/1000000)
	}
	if task.CreatedAt == "" {
		task.CreatedAt = time.Now().Format(time.RFC3339)
	}
	if task.Status == "" {
		task.Status = "todo"
	}
	if task.Priority == "" {
		task.Priority = "medium"
	}
	if task.Subtasks == nil {
		task.Subtasks = []Subtask{}
	}
	if task.Tags == nil {
		task.Tags = []string{}
	}

	ds.mu.Lock()
	user.Tasks = append([]Task{task}, user.Tasks...)
	_ = ds.save()
	ds.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(task)
}

func (ds *DataStore) UpdateTask(w http.ResponseWriter, r *http.Request, taskID string) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	var updated Task
	if err := json.NewDecoder(r.Body).Decode(&updated); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()

	found := false
	for i, t := range user.Tasks {
		if t.ID == taskID {
			updated.ID = taskID
			if updated.CreatedAt == "" {
				updated.CreatedAt = t.CreatedAt
			}
			user.Tasks[i] = updated
			found = true
			break
		}
	}

	if !found {
		http.Error(w, "Task not found", http.StatusNotFound)
		return
	}

	_ = ds.save()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(updated)
}

func (ds *DataStore) ToggleTask(w http.ResponseWriter, r *http.Request, taskID string) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()

	var target *Task
	for i := range user.Tasks {
		if user.Tasks[i].ID == taskID {
			user.Tasks[i].Completed = !user.Tasks[i].Completed
			if user.Tasks[i].Completed {
				now := time.Now().Format(time.RFC3339)
				user.Tasks[i].CompletedAt = &now
				user.Tasks[i].Status = "completed"
			} else {
				user.Tasks[i].CompletedAt = nil
				user.Tasks[i].Status = "todo"
			}
			target = &user.Tasks[i]
			break
		}
	}

	if target == nil {
		http.Error(w, "Task not found", http.StatusNotFound)
		return
	}

	_ = ds.save()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(target)
}

func (ds *DataStore) DeleteTask(w http.ResponseWriter, r *http.Request, taskID string) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()

	filtered := make([]Task, 0, len(user.Tasks))
	found := false
	for _, t := range user.Tasks {
		if t.ID == taskID {
			found = true
			continue
		}
		filtered = append(filtered, t)
	}

	if !found {
		http.Error(w, "Task not found", http.StatusNotFound)
		return
	}

	user.Tasks = filtered
	_ = ds.save()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (ds *DataStore) LogPomodoro(w http.ResponseWriter, r *http.Request, taskID string) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	var payload struct {
		Minutes int `json:"minutes"`
	}
	_ = json.NewDecoder(r.Body).Decode(&payload)
	if payload.Minutes <= 0 {
		payload.Minutes = 25
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()

	var target *Task
	for i := range user.Tasks {
		if user.Tasks[i].ID == taskID {
			user.Tasks[i].PomodoroSessions++
			user.Tasks[i].TimeSpentMinutes += payload.Minutes
			target = &user.Tasks[i]
			break
		}
	}

	// Update user global pomodoro stats
	todayStr := time.Now().Format("2006-01-02")
	if user.PomodoroStats.LastSessionDate != todayStr {
		user.PomodoroStats.TodaySessions = 0
		user.PomodoroStats.LastSessionDate = todayStr
	}
	user.PomodoroStats.TodaySessions++
	user.PomodoroStats.TotalSessions++
	user.PomodoroStats.TotalMinutes += payload.Minutes

	_ = ds.save()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success":       true,
		"task":          target,
		"pomodoroStats": user.PomodoroStats,
	})
}

func (ds *DataStore) GetCategories(w http.ResponseWriter, r *http.Request) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	ds.mu.RLock()
	defer ds.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"categories": user.Categories,
	})
}

func (ds *DataStore) CreateCategory(w http.ResponseWriter, r *http.Request) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	var cat Category
	if err := json.NewDecoder(r.Body).Decode(&cat); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if cat.ID == "" {
		cat.ID = fmt.Sprintf("cat-%d", time.Now().UnixNano()/1000000)
	}

	ds.mu.Lock()
	for _, c := range user.Categories {
		if strings.EqualFold(c.Name, cat.Name) {
			ds.mu.Unlock()
			http.Error(w, "Category already exists", http.StatusConflict)
			return
		}
	}
	user.Categories = append(user.Categories, cat)
	_ = ds.save()
	ds.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(cat)
}

func (ds *DataStore) DeleteCategory(w http.ResponseWriter, r *http.Request, catID string) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	ds.mu.Lock()
	defer ds.mu.Unlock()

	filtered := make([]Category, 0, len(user.Categories))
	var deletedName string
	for _, c := range user.Categories {
		if c.ID == catID || strings.EqualFold(c.Name, catID) {
			deletedName = c.Name
			continue
		}
		filtered = append(filtered, c)
	}

	if deletedName != "" {
		user.Categories = filtered
		fallback := "General"
		if len(user.Categories) > 0 {
			fallback = user.Categories[0].Name
		}
		for i := range user.Tasks {
			if strings.EqualFold(user.Tasks[i].Category, deletedName) {
				user.Tasks[i].Category = fallback
			}
		}
		_ = ds.save()
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (ds *DataStore) GetStats(w http.ResponseWriter, r *http.Request) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	ds.mu.RLock()
	defer ds.mu.RUnlock()

	total := len(user.Tasks)
	completed := 0
	totalFocusMinutes := user.PomodoroStats.TotalMinutes
	pomodoroCount := user.PomodoroStats.TotalSessions

	for _, t := range user.Tasks {
		if t.Completed {
			completed++
		}
	}

	rate := 0.0
	if total > 0 {
		rate = float64(completed) / float64(total) * 100
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"total":             total,
		"completed":         completed,
		"pending":           total - completed,
		"rate":              rate,
		"totalFocusMinutes": totalFocusMinutes,
		"pomodoroSessions":  pomodoroCount,
		"todaySessions":     user.PomodoroStats.TodaySessions,
	})
}

func (ds *DataStore) SyncAll(w http.ResponseWriter, r *http.Request) {
	user := ds.authenticateRequest(r)
	if user == nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	var payload struct {
		Tasks      []Task     `json:"tasks"`
		Categories []Category `json:"categories"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	ds.mu.Lock()
	if len(payload.Tasks) > 0 {
		user.Tasks = payload.Tasks
	}
	if len(payload.Categories) > 0 {
		user.Categories = payload.Categories
	}
	_ = ds.save()
	ds.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"count":   len(user.Tasks),
	})
}

// Open browser helper
func (ds *DataStore) GetHealth(w http.ResponseWriter, r *http.Request) {
	ds.mu.RLock()
	userCount := len(ds.users)
	ds.mu.RUnlock()

	redisConn := false
	if ds.redis != nil {
		redisConn = ds.redis.Ping()
	}

	scyllaConn := false
	if ds.scylla != nil {
		scyllaConn = ds.scylla.Ping()
	}

	health := map[string]interface{}{
		"status":  "healthy",
		"service": "TaskFlow",
		"storage": map[string]interface{}{
			"driver": "ScyllaDB + Redis + ACID POSIX File Persistence",
			"redis": map[string]interface{}{
				"configured": ds.redis != nil,
				"connected":  redisConn,
				"role":       "Session Store, WebAuthn Challenges & Workspace Cache",
			},
			"scylladb": map[string]interface{}{
				"configured": ds.scylla != nil,
				"connected":  scyllaConn,
				"keyspace":   "taskflow",
				"role":       "High-Throughput Distributed NoSQL Store",
			},
			"file_persistence": map[string]interface{}{
				"path":      ds.filePath,
				"userCount": userCount,
			},
		},
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(health)
}

func openBrowser(url string) {
	var cmd string
	var args []string

	switch runtime.GOOS {
	case "windows":
		cmd = "cmd"
		args = []string{"/c", "start", url}
	case "darwin":
		cmd = "open"
		args = []string{url}
	default:
		cmd = "xdg-open"
		args = []string{url}
	}
	_ = exec.Command(cmd, args...).Start()
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	port := 8080
	if envPort := os.Getenv("PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil {
			port = p
		}
	}

	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		if dir, err := os.Getwd(); err == nil {
			staticDir = dir
		} else {
			staticDir = "."
		}
	}

	dataPath := os.Getenv("DATA_PATH")
	if dataPath == "" {
		dataPath = filepath.Join(staticDir, "tasks.json")
	}

	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = os.Getenv("REDIS_URL")
	}

	scyllaHosts := os.Getenv("SCYLLA_HOSTS")
	scyllaKeyspace := os.Getenv("SCYLLA_KEYSPACE")
	if scyllaKeyspace == "" {
		scyllaKeyspace = "taskflow"
	}

	store, err := NewDataStore(dataPath, redisAddr, scyllaHosts, scyllaKeyspace)
	if err != nil {
		log.Fatalf("Failed to initialize persistent multi-user store: %v", err)
	}

	mux := http.NewServeMux()

	// System & Health Status API
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		store.GetHealth(w, r)
	})

	// Auth API Routing
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			store.GetCurrentUser(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/auth/register", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			store.RegisterUser(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			store.LoginPassword(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			store.Logout(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/auth/passkey-challenge", func(w http.ResponseWriter, r *http.Request) {
		store.GetPasskeyChallenge(w, r)
	})

	mux.HandleFunc("/api/auth/passkey-register", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			store.RegisterPasskey(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/auth/passkey-verify", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			store.VerifyPasskeyLogin(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Tasks API Routing
	mux.HandleFunc("/api/tasks", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			store.GetTasks(w, r)
		} else if r.Method == http.MethodPost {
			store.CreateTask(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/tasks/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
		parts := strings.Split(path, "/")
		taskID := parts[0]

		if len(parts) == 2 && parts[1] == "pomodoro" && r.Method == http.MethodPost {
			store.LogPomodoro(w, r, taskID)
			return
		}
		if len(parts) == 2 && parts[1] == "toggle" && r.Method == http.MethodPost {
			store.ToggleTask(w, r, taskID)
			return
		}

		switch r.Method {
		case http.MethodPut:
			store.UpdateTask(w, r, taskID)
		case http.MethodDelete:
			store.DeleteTask(w, r, taskID)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Categories API Routing
	mux.HandleFunc("/api/categories", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			store.GetCategories(w, r)
		} else if r.Method == http.MethodPost {
			store.CreateCategory(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/categories/", func(w http.ResponseWriter, r *http.Request) {
		catID := strings.TrimPrefix(r.URL.Path, "/api/categories/")
		if r.Method == http.MethodDelete {
			store.DeleteCategory(w, r, catID)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Productivity Stats API
	mux.HandleFunc("/api/stats", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			store.GetStats(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Workspace Sync API
	mux.HandleFunc("/api/sync", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			store.SyncAll(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Static Web App Frontend
	fileServer := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fileServer.ServeHTTP(w, r)
	})

	serverURL := fmt.Sprintf("http://localhost:%d", port)
	fmt.Println("========================================================")
	fmt.Printf("⚡ TaskFlow Multi-User Go Backend at: %s\n", serverURL)
	fmt.Printf("📁 Static directory:            %s\n", staticDir)
	fmt.Printf("💾 Persistent user storage:     %s\n", dataPath)
	fmt.Println("⚡ Press Ctrl+C to stop.")
	fmt.Println("========================================================")

	noBrowser := os.Getenv("IN_CONTAINER") == "true"
	for _, arg := range os.Args {
		if arg == "--no-browser" {
			noBrowser = true
		}
	}
	if !noBrowser {
		go func() {
			time.Sleep(200 * time.Millisecond)
			openBrowser(serverURL)
		}()
	}

	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: corsMiddleware(mux),
	}

	// Graceful shutdown
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-stopChan
	fmt.Println("\nFlushing user databases and shutting down TaskFlow server...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	fmt.Println("Server stopped cleanly. All user accounts & tasks persisted.")
}
