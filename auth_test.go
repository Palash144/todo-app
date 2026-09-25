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

	// 3. Test Logout (Session Invalidation)
	reqLogout := httptest.NewRequest("POST", "/api/auth/logout", nil)
	reqLogout.Header.Set("Authorization", "Bearer "+demoToken)
	recLogout := httptest.NewRecorder()
	ds.Logout(recLogout, reqLogout)

	if recLogout.Code != http.StatusOK {
		t.Fatalf("Logout expected 200, got %d", recLogout.Code)
	}

	// Verify token is now invalid (401)
	reqMeAfterLogout := httptest.NewRequest("GET", "/api/auth/me", nil)
	reqMeAfterLogout.Header.Set("Authorization", "Bearer "+demoToken)
	recMeAfterLogout := httptest.NewRecorder()
	ds.GetCurrentUser(recMeAfterLogout, reqMeAfterLogout)

	if recMeAfterLogout.Code != http.StatusUnauthorized {
		t.Fatalf("Post-logout request expected 401, got %d", recMeAfterLogout.Code)
	}

	// 4. Test New User Registration & Immediate Authentication Redirection
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
	if regResp["token"] == nil || regResp["user"] == nil {
		t.Fatalf("Registration response must include token and user object: %v", regResp)
	}
	johnToken := regResp["token"].(string)
	userObj := regResp["user"].(map[string]interface{})
	if userObj["displayName"] != "John Doe" || userObj["username"] != "john_doe" {
		t.Fatalf("Registered user profile mismatch: %v", userObj)
	}

	// 5. Test Authenticated Profile Access for New User
	reqJohnMe := httptest.NewRequest("GET", "/api/auth/me", nil)
	reqJohnMe.Header.Set("Authorization", "Bearer "+johnToken)
	recJohnMe := httptest.NewRecorder()
	ds.GetCurrentUser(recJohnMe, reqJohnMe)

	if recJohnMe.Code != http.StatusOK {
		t.Fatalf("John profile expected 200, got %d", recJohnMe.Code)
	}

	// 6. Test Task Creation for Registered User
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

	// 7. Test Health Endpoint
	reqHealth := httptest.NewRequest("GET", "/api/health", nil)
	recHealth := httptest.NewRecorder()
	ds.GetHealth(recHealth, reqHealth)

	if recHealth.Code != http.StatusOK {
		t.Fatalf("Health check expected 200, got %d: %s", recHealth.Code, recHealth.Body.String())
	}
}
