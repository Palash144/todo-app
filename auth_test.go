package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestAuthAndRegistrationFlow(t *testing.T) {
	testFile := "/tmp/test_datastore.json"
	_ = os.Remove(testFile)
	defer os.Remove(testFile)

	ds, err := NewDataStore(testFile, "", "", "")
	if err != nil {
		t.Fatalf("Failed to initialize datastore: %v", err)
	}

	// 1. Test Demo User Login
	loginBody, _ := json.Marshal(map[string]string{
		"username": "demo",
		"password": "demo123",
	})
	req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(loginBody))
	rec := httptest.NewRecorder()
	ds.LoginPassword(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Demo login expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var demoResp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &demoResp); err != nil || demoResp["token"] == "" {
		t.Fatalf("Demo login token missing or invalid JSON: %v", err)
	}
	demoToken := demoResp["token"].(string)

	// 2. Test Get Current User with valid token
	reqMe := httptest.NewRequest("GET", "/api/auth/me", nil)
	reqMe.Header.Set("Authorization", "Bearer "+demoToken)
	recMe := httptest.NewRecorder()
	ds.GetCurrentUser(recMe, reqMe)

	if recMe.Code != http.StatusOK {
		t.Fatalf("Get current user expected 200, got %d: %s", recMe.Code, recMe.Body.String())
	}

	// 3. Test Unauthenticated Request
	reqUnauth := httptest.NewRequest("GET", "/api/auth/me", nil)
	recUnauth := httptest.NewRecorder()
	ds.GetCurrentUser(recUnauth, reqUnauth)

	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("Unauth request expected 401, got %d", recUnauth.Code)
	}

	// 4. Test New User Registration
	regBody, _ := json.Marshal(map[string]string{
		"username":    "john_doe",
		"displayName": "John Doe",
		"password":    "securepass99",
	})
	reqReg := httptest.NewRequest("POST", "/api/auth/register", bytes.NewReader(regBody))
	recReg := httptest.NewRecorder()
	ds.RegisterUser(recReg, reqReg)

	if recReg.Code != http.StatusCreated {
		t.Fatalf("Registration expected 201, got %d: %s", recReg.Code, recReg.Body.String())
	}

	var regResp map[string]interface{}
	_ = json.Unmarshal(recReg.Body.Bytes(), &regResp)
	johnToken := regResp["token"].(string)

	// 5. Test Login with New User's Password
	loginJohn, _ := json.Marshal(map[string]string{
		"username": "john_doe",
		"password": "securepass99",
	})
	reqLogJohn := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(loginJohn))
	recLogJohn := httptest.NewRecorder()
	ds.LoginPassword(recLogJohn, reqLogJohn)

	if recLogJohn.Code != http.StatusOK {
		t.Fatalf("John login expected 200, got %d: %s", recLogJohn.Code, recLogJohn.Body.String())
	}

	// 6. Test Login with Incorrect Password
	badLogin, _ := json.Marshal(map[string]string{
		"username": "john_doe",
		"password": "wrong_password",
	})
	reqBad := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(badLogin))
	recBad := httptest.NewRecorder()
	ds.LoginPassword(recBad, reqBad)

	if recBad.Code != http.StatusUnauthorized {
		t.Fatalf("Bad password expected 401, got %d", recBad.Code)
	}

	// 7. Test Duplicate Registration
	reqDup := httptest.NewRequest("POST", "/api/auth/register", bytes.NewReader(regBody))
	recDup := httptest.NewRecorder()
	ds.RegisterUser(recDup, reqDup)

	if recDup.Code != http.StatusConflict {
		t.Fatalf("Duplicate registration expected 409, got %d", recDup.Code)
	}

	// 8. Test Authenticated Task Creation for John
	taskBody, _ := json.Marshal(map[string]interface{}{
		"title":      "Complete project handover",
		"category":   "Work",
		"priority":   "high",
		"recurrence": "weekly",
	})
	reqTask := httptest.NewRequest("POST", "/api/tasks", bytes.NewReader(taskBody))
	reqTask.Header.Set("Authorization", "Bearer "+johnToken)
	recTask := httptest.NewRecorder()
	ds.CreateTask(recTask, reqTask)

	if recTask.Code != http.StatusCreated {
		t.Fatalf("Task creation expected 201, got %d: %s", recTask.Code, recTask.Body.String())
	}

	// 9. Test Health Check Endpoint
	reqHealth := httptest.NewRequest("GET", "/api/health", nil)
	recHealth := httptest.NewRecorder()
	ds.GetHealth(recHealth, reqHealth)

	if recHealth.Code != http.StatusOK {
		t.Fatalf("Health check expected 200, got %d: %s", recHealth.Code, recHealth.Body.String())
	}
}
