/**
 * TaskFlow - Advanced Multi-User Task & Focus Management Application
 * With WebAuthn Passkey Account Creation, Login & Persistent Storage.
 */

class TaskFlowApp {
  constructor() {
    this.STORAGE_KEY = 'taskflow_data_v2';
    this.THEME_KEY = 'taskflow_theme';
    this.TOKEN_KEY = 'taskflow_auth_token';
    this.USERS_KEY = 'taskflow_local_users';
    
    // Resolve API Base depending on hosting environment
    if (window.location.protocol === 'file:') {
      this.API_BASE = 'http://localhost:8080/api';
    } else if (window.location.port && window.location.port !== '8080' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      this.API_BASE = 'http://localhost:8080/api';
    } else {
      this.API_BASE = '/api';
    }

    // State
    this.tasks = [];
    this.categories = [];
    this.currentView = 'list';
    this.currentFilter = 'all';
    this.searchQuery = '';
    this.sortBy = 'due-asc';
    this.modalSubtasks = [];
    this.draggedTaskId = null;
    this.audioCtx = null;

    // Calendar State
    this.calendarDate = new Date();
    this.calendarMode = 'month'; // 'month' or 'week'
    this.calDraggedTaskId = null;

    // User & Auth State
    this.authToken = sessionStorage.getItem(this.TOKEN_KEY) || localStorage.getItem(this.TOKEN_KEY) || '';
    this.currentUser = null;

    // Pomodoro Timer State
    this.pomoDurations = {
      work: 25 * 60,
      short_break: 5 * 60,
      long_break: 15 * 60
    };
    this.pomoMode = 'work';
    this.pomoTimeLeft = this.pomoDurations.work;
    this.pomoRunning = false;
    this.pomoInterval = null;
    this.pomoActiveTaskId = null;

    this.init();
  }

  getRelativeDate(daysOffset) {
    const d = new Date();
    d.setDate(d.getDate() + daysOffset);
    return d.toISOString().split('T')[0];
  }

  isAuthenticated() {
    return Boolean(this.currentUser && this.currentUser.id && this.authToken);
  }

  async init() {
    this.loadTheme();
    this.bindEvents();
    this.setupConfetti();
    this.updatePomodoroDisplay();

    // Check if user is authenticated on page landing
    const ok = await this.fetchCurrentUser();
    if (!ok) {
      this.tasks = [];
      this.categories = [];
      this.render();
      this.openAuthModal(true);
    } else {
      await this.fetchFromBackend();
      this.render();
    }
  }

  /* -------------------------------------------------------------------------- */
  /* User Account & WebAuthn Passkeys                                           */
  /* -------------------------------------------------------------------------- */

  getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  async fetchCurrentUser() {
    if (!this.authToken) {
      this.currentUser = null;
      this.updateUserUI();
      return false;
    }

    try {
      const res = await fetch(`${this.API_BASE}/auth/me`, {
        headers: this.getAuthHeaders()
      });
      if (res.ok) {
        this.currentUser = await res.json();
        this.updateUserUI();
        return true;
      } else {
        this.authToken = '';
        sessionStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.TOKEN_KEY);
        this.currentUser = null;
        this.updateUserUI();
        return false;
      }
    } catch (e) {
      console.log('Error authenticating with backend:', e);
      this.currentUser = null;
      this.updateUserUI();
      return false;
    }
  }

  updateUserUI() {
    const nameEl = document.getElementById('user-display-name');
    const avatarEl = document.getElementById('user-avatar');
    const modalAvatar = document.getElementById('modal-user-avatar');
    const modalName = document.getElementById('modal-user-displayname');
    const modalUser = document.getElementById('modal-user-username');
    const userPomos = document.getElementById('user-total-pomos');
    const userMins = document.getElementById('user-total-focus-mins');
    const passkeyList = document.getElementById('account-passkeys-list');

    if (!this.currentUser || !this.currentUser.id) {
      if (nameEl) nameEl.textContent = 'Sign In';
      if (avatarEl) avatarEl.textContent = '🔒';
      return;
    }

    const firstLetter = (this.currentUser.displayName || this.currentUser.username || 'U').charAt(0).toUpperCase();

    if (nameEl) nameEl.textContent = this.currentUser.displayName || this.currentUser.username;
    if (avatarEl) avatarEl.textContent = firstLetter;
    if (modalAvatar) modalAvatar.textContent = firstLetter;
    if (modalName) modalName.textContent = this.currentUser.displayName || this.currentUser.username;
    if (modalUser) modalUser.textContent = '@' + (this.currentUser.username || 'guest');

    const stats = this.currentUser.pomodoroStats || { totalSessions: 0, totalMinutes: 0 };
    if (userPomos) userPomos.textContent = stats.totalSessions || 0;
    if (userMins) userMins.textContent = stats.totalMinutes || 0;

    if (passkeyList) {
      const pkeys = this.currentUser.passkeys || [];
      if (pkeys.length === 0) {
        passkeyList.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted);">No passkeys registered for this account.</div>';
      } else {
        passkeyList.innerHTML = pkeys.map(p => `
          <div class="passkey-item">
            <div style="display: flex; align-items: center; gap: 0.6rem;">
              <div class="passkey-icon-badge">🔑</div>
              <div>
                <div style="font-weight: 600;">${this.escapeHtml(p.name)}</div>
                <div style="font-size: 0.72rem; color: var(--text-muted);">${p.createdAt ? new Date(p.createdAt).toLocaleDateString() : 'Active'}</div>
              </div>
            </div>
            <span style="font-size: 0.72rem; background: var(--brand-light); color: var(--brand-light-text); padding: 2px 6px; border-radius: 4px; font-weight: 600;">Active</span>
          </div>
        `).join('');
      }
    }
  }

  openAccountModal() {
    if (!this.isAuthenticated()) {
      this.openAuthModal(true);
      return;
    }
    this.updateUserUI();
    document.getElementById('account-modal').classList.add('active');
  }

  openAuthModal(force = false) {
    this.closeModals(true);
    const authModal = document.getElementById('auth-modal');
    const closeBtn = document.getElementById('auth-modal-close-btn');
    const err = document.getElementById('auth-error-msg');
    if (err) err.style.display = 'none';

    if (closeBtn) {
      closeBtn.style.display = (force || !this.isAuthenticated()) ? 'none' : 'block';
    }

    this.switchAuthTab('login');
    if (authModal) authModal.classList.add('active');
  }


  getLocalUsers() {
    try {
      return JSON.parse(localStorage.getItem(this.USERS_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  saveLocalUser(username, displayName, password) {
    const users = this.getLocalUsers();
    const userObj = {
      id: 'user-' + Date.now(),
      username: username,
      displayName: displayName || username,
      password: password,
      hasPasskeys: false,
      passkeys: [],
      pomodoroStats: { totalSessions: 0, totalMinutes: 0, todaySessions: 0 }
    };
    users[username] = userObj;
    localStorage.setItem(this.USERS_KEY, JSON.stringify(users));
    return userObj;
  }

  switchAuthTab(tab) {
    const signupBtn = document.getElementById('tab-auth-signup');
    const loginBtn = document.getElementById('tab-auth-login');
    const signupPanel = document.getElementById('panel-auth-signup');
    const loginPanel = document.getElementById('panel-auth-login');
    const err = document.getElementById('auth-error-msg');
    if (err) err.style.display = 'none';

    if (tab === 'signup') {
      if (signupBtn) signupBtn.classList.add('active');
      if (loginBtn) loginBtn.classList.remove('active');
      if (signupPanel) signupPanel.style.display = 'flex';
      if (loginPanel) loginPanel.style.display = 'none';
    } else {
      if (loginBtn) loginBtn.classList.add('active');
      if (signupBtn) signupBtn.classList.remove('active');
      if (loginPanel) loginPanel.style.display = 'flex';
      if (signupPanel) signupPanel.style.display = 'none';
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Create Account with Passkey (WebAuthn)                                     */
  /* -------------------------------------------------------------------------- */

  async handleCreateAccountWithPasskey(event) {
    if (event) event.preventDefault();
    const usernameInput = document.getElementById('signup-username');
    const displayInput = document.getElementById('signup-displayname');
    const passwordInput = document.getElementById('signup-password');
    const err = document.getElementById('auth-error-msg');

    if (!usernameInput || !usernameInput.value.trim()) {
      if (err) {
        err.textContent = '❌ Please enter a username.';
        err.style.display = 'block';
      }
      return;
    }

    const username = usernameInput.value.trim();
    const displayName = displayInput ? (displayInput.value.trim() || username) : username;
    const password = passwordInput ? passwordInput.value : '';

    if (!window.PublicKeyCredential) {
      return this.handleCreateAccountPasswordOnly(event);
    }

    try {
      if (err) err.style.display = 'none';

      // 1. Register user in backend first
      let regUserData;
      try {
        const regUserRes = await fetch(`${this.API_BASE}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, displayName, password })
        });

        if (!regUserRes.ok) {
          const errorText = await regUserRes.text();
          throw new Error(errorText || 'Account creation failed');
        }

        regUserData = await regUserRes.json();
      } catch (fetchErr) {
        if (fetchErr.message && (fetchErr.message.includes('taken') || fetchErr.message.includes('characters'))) {
          throw fetchErr;
        }
        console.warn('Backend register unreachable, using local storage:', fetchErr);
        const localUser = this.saveLocalUser(username, displayName, password);
        regUserData = {
          token: 'local-token-' + Date.now(),
          user: localUser
        };
      }

      this.authToken = regUserData.token;
      this.currentUser = regUserData.user;
      sessionStorage.setItem(this.TOKEN_KEY, regUserData.token);
      localStorage.setItem(this.TOKEN_KEY, regUserData.token);

      // 2. Attempt WebAuthn Passkey registration
      try {
        const chalRes = await fetch(`${this.API_BASE}/auth/passkey-challenge`);
        if (chalRes.ok) {
          const chalData = await chalRes.json();
          const challengeBytes = Uint8Array.from(atob(chalData.challenge.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
          const userIdBytes = new TextEncoder().encode(regUserData.user.id || ('user-' + Date.now()));

          const hostname = window.location.hostname || 'localhost';
          const credential = await navigator.credentials.create({
            publicKey: {
              challenge: challengeBytes,
              rp: {
                name: 'TaskFlow Workspace',
                id: hostname === 'localhost' ? 'localhost' : hostname
              },
              user: {
                id: userIdBytes,
                name: username,
                displayName: displayName
              },
              pubKeyCredParams: [
                { type: 'public-key', alg: -7 },  // ES256
                { type: 'public-key', alg: -257 } // RS256
              ],
              authenticatorSelection: {
                userVerification: 'preferred',
                residentKey: 'preferred'
              },
              timeout: 60000,
              attestation: 'none'
            }
          });

          if (credential) {
            const rawIdB64 = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
            await fetch(`${this.API_BASE}/auth/passkey-register`, {
              method: 'POST',
              headers: this.getAuthHeaders(),
              body: JSON.stringify({
                id: credential.id,
                rawId: rawIdB64,
                type: credential.type,
                name: 'Primary Passkey (' + (navigator.platform || 'Device') + ')',
                username: username
              })
            });
          }
        }
      } catch (passkeyErr) {
        console.warn('Biometric passkey prompt skipped/canceled:', passkeyErr);
      }

      await this.fetchCurrentUser();
      if (!this.currentUser) {
        this.currentUser = regUserData.user;
      }
      this.updateUserUI();
      await this.fetchFromBackend();

      this.closeModals(true);
      this.render();
      this.playSuccessChime();
      this.triggerConfetti();
      this.showToast(`🎉 Welcome to TaskFlow, ${this.currentUser.displayName || this.currentUser.username}!`, 'success');
    } catch (e) {
      console.error('Sign up error:', e);
      if (err) {
        err.textContent = '❌ ' + (e.message || 'Registration failed');
        err.style.display = 'block';
      }
    }
  }

  async handleCreateAccountPasswordOnly(event) {
    if (event) event.preventDefault();
    const usernameInput = document.getElementById('signup-username');
    const displayInput = document.getElementById('signup-displayname');
    const passwordInput = document.getElementById('signup-password');
    const err = document.getElementById('auth-error-msg');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const displayName = displayInput ? (displayInput.value.trim() || username) : username;
    const password = passwordInput ? passwordInput.value : '';

    if (!username) {
      if (err) {
        err.textContent = '❌ Please enter a username.';
        err.style.display = 'block';
      }
      return;
    }

    try {
      if (err) err.style.display = 'none';

      let data;
      try {
        const res = await fetch(`${this.API_BASE}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, displayName, password })
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(errorText || 'Failed to create account');
        }
        data = await res.json();
      } catch (fetchErr) {
        // If network failed (e.g. backend server starting up or file:// protocol), fall back to local storage
        if (fetchErr.message && (fetchErr.message.includes('taken') || fetchErr.message.includes('characters'))) {
          throw fetchErr;
        }
        console.warn('Backend register unreachable, using local storage:', fetchErr);
        const localUser = this.saveLocalUser(username, displayName, password);
        data = {
          token: 'local-token-' + Date.now(),
          user: localUser
        };
      }

      this.authToken = data.token;
      sessionStorage.setItem(this.TOKEN_KEY, data.token);
      localStorage.setItem(this.TOKEN_KEY, data.token);

      const ok = await this.fetchCurrentUser();
      if (!ok) {
        this.currentUser = data.user;
        this.updateUserUI();
      }
      await this.fetchFromBackend();
      this.closeModals(true);
      this.render();
      this.playSuccessChime();
      this.triggerConfetti();
      this.showToast(`🎉 Welcome to TaskFlow, ${this.currentUser.displayName || this.currentUser.username}!`, 'success');
    } catch (e) {
      console.error('Registration error:', e);
      if (err) {
        err.textContent = '❌ ' + (e.message || 'Error creating account');
        err.style.display = 'block';
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Passkey & Password Authentication                                          */
  /* -------------------------------------------------------------------------- */

  async handlePasskeyLogin() {
    if (!window.PublicKeyCredential) {
      alert('Passkeys are not supported by this browser.');
      return;
    }

    const err = document.getElementById('auth-error-msg');
    if (err) err.style.display = 'none';

    try {
      const chalRes = await fetch(`${this.API_BASE}/auth/passkey-challenge`);
      const chalData = await chalRes.json();
      const challengeBytes = Uint8Array.from(atob(chalData.challenge.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

      const hostname = window.location.hostname || 'localhost';
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: challengeBytes,
          rpId: hostname === 'localhost' ? 'localhost' : hostname,
          userVerification: 'preferred',
          timeout: 60000
        }
      });

      if (!assertion) throw new Error('Biometric login canceled');

      const rawIdB64 = btoa(String.fromCharCode(...new Uint8Array(assertion.rawId)));
      const verifyRes = await fetch(`${this.API_BASE}/auth/passkey-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: assertion.id,
          rawId: rawIdB64,
          challenge: chalData.challenge
        })
      });

      if (!verifyRes.ok) {
        const errorText = await verifyRes.text();
        throw new Error(errorText || 'Passkey verification failed');
      }

      const data = await verifyRes.json();
      this.authToken = data.token;
      sessionStorage.setItem(this.TOKEN_KEY, data.token);
      localStorage.setItem(this.TOKEN_KEY, data.token);

      await this.fetchCurrentUser();
      await this.fetchFromBackend();
      this.closeModals(true);
      this.render();
      this.playSuccessChime();
      this.triggerConfetti();
      this.showToast(`Welcome back, ${this.currentUser.displayName || this.currentUser.username}!`, 'success');
    } catch (e) {
      console.error('Passkey sign in error:', e);
      if (err) {
        err.textContent = '❌ Passkey login failed: ' + (e.message || 'Canceled');
        err.style.display = 'block';
      }
    }
  }

  async handleDemoLogin() {
    const err = document.getElementById('auth-error-msg');
    if (err) err.style.display = 'none';

    try {
      let data;
      try {
        const res = await fetch(`${this.API_BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'demo',
            password: 'demo123'
          })
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(errorText || 'Demo account login failed');
        }
        data = await res.json();
      } catch (fetchErr) {
        console.warn('Backend demo login unreachable, initializing local demo session:', fetchErr);
        data = {
          token: 'local-demo-token',
          user: { id: 'user-demo', username: 'demo', displayName: 'Demo User', hasPasskeys: false, passkeys: [] }
        };
      }

      this.authToken = data.token;
      sessionStorage.setItem(this.TOKEN_KEY, data.token);
      localStorage.setItem(this.TOKEN_KEY, data.token);

      const ok = await this.fetchCurrentUser();
      if (!ok) {
        this.currentUser = data.user;
        this.updateUserUI();
      }
      await this.fetchFromBackend();
      this.closeModals(true);
      this.render();
      this.playSuccessChime();
      this.triggerConfetti();
      this.showToast(`Logged in as Demo User`, 'success');
    } catch (e) {
      console.error('Demo login error:', e);
      if (err) {
        err.textContent = '❌ ' + (e.message || 'Demo login failed');
        err.style.display = 'block';
      }
    }
  }

  async handlePasswordLogin(event) {
    if (event) event.preventDefault();
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const err = document.getElementById('auth-error-msg');

    if (!usernameInput || !passwordInput) return;
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      if (err) {
        err.textContent = '❌ Please enter both username and password.';
        err.style.display = 'block';
      }
      return;
    }

    try {
      if (err) err.style.display = 'none';

      let data;
      try {
        const res = await fetch(`${this.API_BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(errorText || 'Invalid username or password');
        }
        data = await res.json();
      } catch (fetchErr) {
        if (fetchErr.message && (fetchErr.message.includes('Invalid') || fetchErr.message.includes('password'))) {
          throw fetchErr;
        }
        console.warn('Backend login unreachable, attempting local authentication:', fetchErr);
        const localUsers = this.getLocalUsers();
        if (localUsers[username] && localUsers[username].password === password) {
          data = {
            token: 'local-token-' + Date.now(),
            user: localUsers[username]
          };
        } else if (username === 'demo' && password === 'demo123') {
          data = {
            token: 'local-demo-token',
            user: { id: 'user-demo', username: 'demo', displayName: 'Demo User', hasPasskeys: false, passkeys: [] }
          };
        } else {
          throw new Error('Invalid username or password');
        }
      }

      this.authToken = data.token;
      sessionStorage.setItem(this.TOKEN_KEY, data.token);
      localStorage.setItem(this.TOKEN_KEY, data.token);

      const ok = await this.fetchCurrentUser();
      if (!ok) {
        this.currentUser = data.user;
        this.updateUserUI();
      }
      await this.fetchFromBackend();
      this.closeModals(true);
      this.render();
      this.playSuccessChime();
      this.triggerConfetti();
      this.showToast(`Welcome back, ${this.currentUser.displayName || this.currentUser.username}!`, 'success');
    } catch (e) {
      console.error('Login error:', e);
      if (err) {
        err.textContent = '❌ ' + (e.message || 'Login failed');
        err.style.display = 'block';
      }
    }
  }

  async registerPasskeyForActiveUser() {
    if (!window.PublicKeyCredential) {
      alert('Passkeys are not supported by this browser.');
      return;
    }

    try {
      const chalRes = await fetch(`${this.API_BASE}/auth/passkey-challenge`);
      const chalData = await chalRes.json();
      const challengeBytes = Uint8Array.from(atob(chalData.challenge.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const userIdBytes = new TextEncoder().encode(this.currentUser.id);

      const hostname = window.location.hostname || 'localhost';
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: challengeBytes,
          rp: {
            name: 'TaskFlow Workspace',
            id: hostname === 'localhost' ? 'localhost' : hostname
          },
          user: {
            id: userIdBytes,
            name: this.currentUser.username,
            displayName: this.currentUser.displayName || this.currentUser.username
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 }
          ],
          authenticatorSelection: {
            userVerification: 'preferred',
            residentKey: 'preferred'
          },
          timeout: 60000,
          attestation: 'none'
        }
      });

      if (credential) {
        const rawIdB64 = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
        const res = await fetch(`${this.API_BASE}/auth/passkey-register`, {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            id: credential.id,
            rawId: rawIdB64,
            type: credential.type,
            name: 'Biometric Passkey (' + (navigator.platform || 'Device') + ')'
          })
        });

        if (res.ok) {
          await this.fetchCurrentUser();
          this.updateUserUI();
          this.showToast('Passkey registered successfully!', 'success');
        }
      }
    } catch (e) {
      console.error('Passkey registration error:', e);
      alert('Could not register passkey: ' + (e.message || 'Canceled'));
    }
  }

  async logoutUser() {
    try {
      if (this.authToken) {
        await fetch(`${this.API_BASE}/auth/logout`, {
          method: 'POST',
          headers: this.getAuthHeaders()
        });
      }
    } catch (e) {
      console.warn('Backend logout warning:', e);
    }

    this.authToken = '';
    this.currentUser = null;
    this.tasks = [];
    this.categories = [];
    sessionStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.TOKEN_KEY);

    this.closeModals(true);
    this.updateUserUI();
    this.render();
    this.openAuthModal(true);
    this.showToast('You have been logged out', 'info');
  }

  /* Backend API & Data Synchronization                                         */
  /* -------------------------------------------------------------------------- */

  async fetchFromBackend() {
    try {
      const [tasksRes, catsRes] = await Promise.all([
        fetch(`${this.API_BASE}/tasks`, { headers: this.getAuthHeaders() }),
        fetch(`${this.API_BASE}/categories`, { headers: this.getAuthHeaders() })
      ]);

      if (tasksRes.ok) {
        const data = await tasksRes.json();
        if (Array.isArray(data.tasks)) {
          this.tasks = data.tasks;
        }
      }
      if (catsRes.ok) {
        const data = await catsRes.json();
        if (Array.isArray(data.categories) && data.categories.length > 0) {
          this.categories = data.categories;
        }
      }

      this.saveDataLocally();
      this.render();
    } catch (e) {
      console.log('Using local storage mirror.');
    }
  }

  async apiCreateTask(task) {
    try {
      await fetch(`${this.API_BASE}/tasks`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(task)
      });
    } catch (e) {}
  }

  async apiUpdateTask(task) {
    try {
      await fetch(`${this.API_BASE}/tasks/${task.id}`, {
        method: 'PUT',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(task)
      });
    } catch (e) {}
  }

  async apiToggleTask(taskId) {
    try {
      await fetch(`${this.API_BASE}/tasks/${taskId}/toggle`, {
        method: 'POST',
        headers: this.getAuthHeaders()
      });
    } catch (e) {}
  }

  async apiDeleteTask(taskId) {
    try {
      await fetch(`${this.API_BASE}/tasks/${taskId}`, {
        method: 'DELETE',
        headers: this.getAuthHeaders()
      });
    } catch (e) {}
  }

  async apiLogPomodoro(taskId, minutes) {
    try {
      const res = await fetch(`${this.API_BASE}/tasks/${taskId}/pomodoro`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ minutes })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.pomodoroStats) {
          this.currentUser.pomodoroStats = data.pomodoroStats;
          this.updateUserUI();
        }
      }
    } catch (e) {}
  }

  async apiCreateCategory(cat) {
    try {
      await fetch(`${this.API_BASE}/categories`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(cat)
      });
    } catch (e) {}
  }

  async apiDeleteCategory(catId) {
    try {
      await fetch(`${this.API_BASE}/categories/${catId}`, {
        method: 'DELETE',
        headers: this.getAuthHeaders()
      });
    } catch (e) {}
  }

  loadData() {
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        this.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        this.categories = Array.isArray(parsed.categories) ? parsed.categories : [];
      }
    } catch (e) {}
  }

  saveDataLocally() {
    try {
      const payload = {
        tasks: this.tasks,
        categories: this.categories,
        lastUpdated: new Date().toISOString()
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {}
  }

  saveData() {
    this.saveDataLocally();
  }

  resetSampleData() {
    if (confirm('Reset your tasks to starter template data?')) {
      const d = new Date();
      this.tasks = [
        {
          id: 'task-' + Date.now(),
          title: 'Review quarterly project roadmap & deliverables',
          notes: 'Coordinate milestones with team leads. Focus on distributed cache invalidation strategies.\n\n- Update slide deck\n- Prepare metrics report',
          category: 'Work',
          priority: 'urgent',
          status: 'inprogress',
          completed: false,
          dueDate: this.getRelativeDate(0),
          dueTime: '15:00',
          tags: ['deep-work', 'planning'],
          estimatedMinutes: 60,
          timeSpentMinutes: 25,
          pomodoroSessions: 1,
          starred: true,
          createdAt: new Date().toISOString(),
          subtasks: [
            { id: 'st-1', title: 'Collect metric updates', completed: true },
            { id: 'st-2', title: 'Prepare summary slide', completed: false }
          ]
        }
      ];
      this.saveData();
      this.closeModals();
      this.render();
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Theme Handling                                                             */
  /* -------------------------------------------------------------------------- */

  loadTheme() {
    const savedTheme = localStorage.getItem(this.THEME_KEY) || 
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', savedTheme);
    this.updateThemeIcons(savedTheme);
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(this.THEME_KEY, next);
    this.updateThemeIcons(next);
  }

  updateThemeIcons(theme) {
    const moon = document.getElementById('theme-moon-icon');
    const sun = document.getElementById('theme-sun-icon');
    if (moon && sun) {
      if (theme === 'dark') {
        moon.style.display = 'none';
        sun.style.display = 'block';
      } else {
        moon.style.display = 'block';
        sun.style.display = 'none';
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Web Audio Synthesizer                                                      */
  /* -------------------------------------------------------------------------- */

  getAudioContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  playSuccessChime() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.07);

        gain.gain.setValueAtTime(0.0001, ctx.currentTime + idx * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + idx * 0.07 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + idx * 0.07 + 0.28);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime + idx * 0.07);
        osc.stop(ctx.currentTime + idx * 0.07 + 0.3);
      });
    } catch (e) {}
  }

  playPomodoroChime(isBreak) {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const notes = isBreak ? [440, 554.37, 659.25] : [587.33, 739.99, 880, 1174.66];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.12);

        gain.gain.setValueAtTime(0.0001, ctx.currentTime + idx * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + idx * 0.12 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + idx * 0.12 + 0.45);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime + idx * 0.12);
        osc.stop(ctx.currentTime + idx * 0.12 + 0.5);
      });
    } catch (e) {}
  }

  /* -------------------------------------------------------------------------- */
  /* Confetti Particle Engine                                                   */
  /* -------------------------------------------------------------------------- */

  setupConfetti() {
    const canvas = document.getElementById('confetti-canvas');
    if (!canvas) return;
    this.confettiCanvas = canvas;
    this.confettiCtx = canvas.getContext('2d');
    this.confettiParticles = [];
    this.confettiAnimationId = null;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resize);
    resize();
  }

  triggerConfetti() {
    if (!this.confettiCanvas || !this.confettiCtx) return;

    const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4'];
    const particleCount = 70;

    for (let i = 0; i < particleCount; i++) {
      this.confettiParticles.push({
        x: window.innerWidth * 0.5 + (Math.random() - 0.5) * 200,
        y: window.innerHeight * 0.6 + (Math.random() - 0.5) * 100,
        vx: (Math.random() - 0.5) * 14,
        vy: -Math.random() * 12 - 6,
        size: Math.random() * 8 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 10,
        alpha: 1,
        life: 1
      });
    }

    if (!this.confettiAnimationId) {
      this.animateConfetti();
    }
  }

  animateConfetti() {
    if (!this.confettiCtx) return;
    this.confettiCtx.clearRect(0, 0, this.confettiCanvas.width, this.confettiCanvas.height);

    for (let i = this.confettiParticles.length - 1; i >= 0; i--) {
      const p = this.confettiParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35;
      p.rotation += p.rotationSpeed;
      p.life -= 0.015;
      p.alpha = Math.max(0, p.life);

      if (p.alpha <= 0 || p.y > this.confettiCanvas.height) {
        this.confettiParticles.splice(i, 1);
        continue;
      }

      this.confettiCtx.save();
      this.confettiCtx.translate(p.x, p.y);
      this.confettiCtx.rotate((p.rotation * Math.PI) / 180);
      this.confettiCtx.globalAlpha = p.alpha;
      this.confettiCtx.fillStyle = p.color;
      this.confettiCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      this.confettiCtx.restore();
    }

    if (this.confettiParticles.length > 0) {
      this.confettiAnimationId = requestAnimationFrame(() => this.animateConfetti());
    } else {
      this.confettiAnimationId = null;
      this.confettiCtx.clearRect(0, 0, this.confettiCanvas.width, this.confettiCanvas.height);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Markdown Rendering Engine                                                  */
  /* -------------------------------------------------------------------------- */

  renderMarkdown(text) {
    if (!text) return '';

    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    escaped = escaped.replace(/_([^_]+)_/g, '<em>$1</em>');
    escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    const lines = escaped.split('\n');
    let inList = false;
    let html = '';

    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${trimmed.substring(2)}</li>`;
      } else {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        if (trimmed) {
          html += `<p>${trimmed}</p>`;
        }
      }
    });

    if (inList) {
      html += '</ul>';
    }

    return html;
  }

  /* -------------------------------------------------------------------------- */
  /* Pomodoro Timer Engine                                                      */
  /* -------------------------------------------------------------------------- */

  openPomodoroModal(taskId = null) {
    if (taskId) {
      this.pomoActiveTaskId = taskId;
    }
    this.populatePomodoroTaskPicker();
    this.updatePomodoroDisplay();
    document.getElementById('pomodoro-modal').classList.add('active');
  }

  populatePomodoroTaskPicker() {
    const picker = document.getElementById('pomo-task-picker');
    const nameEl = document.getElementById('pomo-active-task-name');
    if (!picker) return;

    const uncompletedTasks = this.tasks.filter(t => !t.completed);
    picker.innerHTML = '<option value="">Select a task...</option>' + 
      uncompletedTasks.map(t => `<option value="${t.id}" ${t.id === this.pomoActiveTaskId ? 'selected' : ''}>${this.escapeHtml(t.title)}</option>`).join('');

    if (this.pomoActiveTaskId) {
      const task = this.tasks.find(t => t.id === this.pomoActiveTaskId);
      if (nameEl) nameEl.textContent = task ? task.title : 'No Task Selected';
      picker.value = this.pomoActiveTaskId;
    } else {
      if (nameEl) nameEl.textContent = 'No Task Selected';
    }
  }

  selectPomodoroTask(taskId) {
    this.pomoActiveTaskId = taskId || null;
    this.populatePomodoroTaskPicker();
    this.updatePomodoroDisplay();
    this.renderTasks();
  }

  switchPomodoroMode(mode) {
    this.pomoMode = mode;
    this.pomoTimeLeft = this.pomoDurations[mode];
    this.pausePomodoro();

    const workTab = document.getElementById('pomo-tab-work');
    const shortTab = document.getElementById('pomo-tab-short');
    const longTab = document.getElementById('pomo-tab-long');

    if (workTab) workTab.classList.toggle('active', mode === 'work');
    if (shortTab) shortTab.classList.toggle('active', mode === 'short_break');
    if (longTab) longTab.classList.toggle('active', mode === 'long_break');

    const playBtn = document.getElementById('pomo-play-btn');
    if (playBtn) {
      playBtn.classList.toggle('break', mode !== 'work');
    }

    const ringProgress = document.getElementById('pomo-svg-progress');
    if (ringProgress) {
      ringProgress.style.stroke = mode === 'work' ? '#ef4444' : '#10b981';
    }

    this.updatePomodoroDisplay();
  }

  togglePomodoro() {
    if (this.pomoRunning) {
      this.pausePomodoro();
    } else {
      this.startPomodoro();
    }
  }

  startPomodoro() {
    if (this.pomoRunning) return;
    this.pomoRunning = true;
    this.updatePomodoroPlayButton();

    this.pomoInterval = setInterval(() => {
      this.pomoTimeLeft--;

      if (this.pomoTimeLeft <= 0) {
        this.handlePomodoroComplete();
      }

      this.updatePomodoroDisplay();
    }, 1000);
  }

  pausePomodoro() {
    this.pomoRunning = false;
    if (this.pomoInterval) {
      clearInterval(this.pomoInterval);
      this.pomoInterval = null;
    }
    this.updatePomodoroPlayButton();
  }

  resetPomodoro() {
    this.pausePomodoro();
    this.pomoTimeLeft = this.pomoDurations[this.pomoMode];
    this.updatePomodoroDisplay();
  }

  skipPomodoro() {
    if (this.pomoMode === 'work') {
      this.switchPomodoroMode('short_break');
    } else {
      this.switchPomodoroMode('work');
    }
  }

  async handlePomodoroComplete() {
    this.pausePomodoro();

    if (this.pomoMode === 'work') {
      if (this.pomoActiveTaskId) {
        const task = this.tasks.find(t => t.id === this.pomoActiveTaskId);
        if (task) {
          task.pomodoroSessions = (task.pomodoroSessions || 0) + 1;
          task.timeSpentMinutes = (task.timeSpentMinutes || 0) + 25;
          await this.apiLogPomodoro(task.id, 25);
        }
      }

      this.playPomodoroChime(false);
      this.triggerConfetti();

      if (Notification.permission === 'granted') {
        new Notification('🍅 Pomodoro Complete!', {
          body: 'Great focus! Time for a well-deserved 5-minute break.'
        });
      }

      this.switchPomodoroMode('short_break');
      this.startPomodoro();
    } else {
      this.playPomodoroChime(true);
      if (Notification.permission === 'granted') {
        new Notification('⚡ Break Finished!', {
          body: 'Break is over. Ready to dive back into deep work?'
        });
      }
      this.switchPomodoroMode('work');
    }

    this.saveData();
    this.render();
  }

  updatePomodoroPlayButton() {
    const playIcon = document.getElementById('pomo-play-icon');
    const pauseIcon = document.getElementById('pomo-pause-icon');
    if (playIcon && pauseIcon) {
      playIcon.style.display = this.pomoRunning ? 'none' : 'block';
      pauseIcon.style.display = this.pomoRunning ? 'block' : 'none';
    }

    const miniWidget = document.getElementById('pomo-mini-widget');
    if (miniWidget) {
      miniWidget.classList.toggle('running', this.pomoRunning);
      miniWidget.classList.toggle('break-mode', this.pomoMode !== 'work');
    }
  }

  updatePomodoroDisplay() {
    const mins = Math.floor(this.pomoTimeLeft / 60);
    const secs = this.pomoTimeLeft % 60;
    const timeFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const displayTimeEl = document.getElementById('pomo-display-time');
    const labelEl = document.getElementById('pomo-display-label');
    if (displayTimeEl) displayTimeEl.textContent = timeFormatted;
    if (labelEl) {
      labelEl.textContent = this.pomoMode === 'work' ? 'Deep Work' : this.pomoMode === 'short_break' ? 'Short Break' : 'Long Break';
    }

    const miniTime = document.getElementById('pomo-mini-time');
    const miniIcon = document.getElementById('pomo-mini-icon');
    const miniTask = document.getElementById('pomo-mini-task');
    if (miniTime) miniTime.textContent = timeFormatted;
    if (miniIcon) miniIcon.textContent = this.pomoMode === 'work' ? '🍅' : '☕';

    if (miniTask) {
      if (this.pomoActiveTaskId) {
        const task = this.tasks.find(t => t.id === this.pomoActiveTaskId);
        if (task) {
          miniTask.textContent = task.title;
          miniTask.style.display = 'inline-block';
        } else {
          miniTask.style.display = 'none';
        }
      } else {
        miniTask.style.display = 'none';
      }
    }

    const ring = document.getElementById('pomo-svg-progress');
    if (ring) {
      const totalSeconds = this.pomoDurations[this.pomoMode];
      const circumference = 2 * Math.PI * 95;
      const fraction = this.pomoTimeLeft / totalSeconds;
      const offset = circumference * (1 - fraction);
      ring.style.strokeDashoffset = offset;
    }

    const pStats = this.currentUser.pomodoroStats || { todaySessions: 0, totalMinutes: 0 };
    const completedTodayEl = document.getElementById('pomo-completed-today-count');
    const focusMinsEl = document.getElementById('pomo-total-focus-minutes');
    if (completedTodayEl) completedTodayEl.textContent = pStats.todaySessions || 0;
    if (focusMinsEl) focusMinsEl.textContent = pStats.totalMinutes || 0;

    document.title = `${timeFormatted} ${this.pomoMode === 'work' ? '🍅' : '☕'} | TaskFlow`;
  }

  /* -------------------------------------------------------------------------- */
  /* Events & Keyboard Shortcuts                                                */
  /* -------------------------------------------------------------------------- */

  bindEvents() {
    const searchInput = document.getElementById('global-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        this.renderTasks();
      });
    }

    const quickAddInput = document.getElementById('quick-add-input');
    if (quickAddInput) {
      quickAddInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleQuickAdd();
        }
      });
    }

    const subtaskInput = document.getElementById('new-subtask-input');
    if (subtaskInput) {
      subtaskInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.addModalSubtask();
        }
      });
    }

    window.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      const isInputActive = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';

      if (e.key === 'Escape') {
        if (this.isAuthenticated()) {
          this.closeModals();
        }
        if (isInputActive) document.activeElement.blur();
        return;
      }

      if (isInputActive || !this.isAuthenticated()) return;

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        this.openTaskModal();
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        this.openPomodoroModal();
      } else if (e.key === 'u' || e.key === 'U') {
        e.preventDefault();
        this.openAccountModal();
      } else if (e.key === '/') {
        e.preventDefault();
        const s = document.getElementById('global-search');
        if (s) s.focus();
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        this.toggleTheme();
      } else if (e.key === '1') {
        this.setView('list');
      } else if (e.key === '2') {
        this.setView('kanban');
      } else if (e.key === '3') {
        this.setView('matrix');
      } else if (e.key === '4') {
        this.setView('calendar');
      } else if (e.key === '?') {
        this.openShortcutsModal();
      }
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          if (overlay.id === 'auth-modal' && !this.isAuthenticated()) {
            return;
          }
          this.closeModals();
        }
      });
    });

    if ('Notification' in window && Notification.permission === 'default') {
      document.addEventListener('click', () => {
        Notification.requestPermission();
      }, { once: true });
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Navigation & Views                                                         */
  /* -------------------------------------------------------------------------- */

  setView(viewName) {
    this.currentView = viewName;
    const listBtn = document.getElementById('view-list-btn');
    const kanbanBtn = document.getElementById('view-kanban-btn');
    const matrixBtn = document.getElementById('view-matrix-btn');
    const calBtn = document.getElementById('view-calendar-btn');

    if (listBtn) listBtn.classList.toggle('active', viewName === 'list');
    if (kanbanBtn) kanbanBtn.classList.toggle('active', viewName === 'kanban');
    if (matrixBtn) matrixBtn.classList.toggle('active', viewName === 'matrix');
    if (calBtn) calBtn.classList.toggle('active', viewName === 'calendar');

    const listCont = document.getElementById('view-list-container');
    const kanbanCont = document.getElementById('view-kanban-container');
    const matrixCont = document.getElementById('view-matrix-container');
    const calCont = document.getElementById('view-calendar-container');

    if (listCont) listCont.style.display = viewName === 'list' ? 'block' : 'none';
    if (kanbanCont) kanbanCont.style.display = viewName === 'kanban' ? 'block' : 'none';
    if (matrixCont) matrixCont.style.display = viewName === 'matrix' ? 'block' : 'none';
    if (calCont) calCont.style.display = viewName === 'calendar' ? 'block' : 'none';

    this.renderTasks();
  }

  setFilter(filterName) {
    this.currentFilter = filterName;
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.filter === filterName);
    });

    const titleEl = document.getElementById('workspace-title');
    if (titleEl) {
      if (filterName.startsWith('cat:')) {
        titleEl.textContent = filterName.replace('cat:', '') + ' Tasks';
      } else if (filterName.startsWith('tag:')) {
        titleEl.textContent = '#' + filterName.replace('tag:', '') + ' Tasks';
      } else {
        const titles = {
          all: 'All Tasks',
          today: "Today's Tasks",
          upcoming: 'Upcoming Tasks',
          important: 'Important & Starred',
          overdue: 'Overdue Tasks',
          completed: 'Completed Tasks'
        };
        titleEl.textContent = titles[filterName] || 'Tasks';
      }
    }

    this.renderTasks();
  }

  setSort(sortVal) {
    this.sortBy = sortVal;
    this.renderTasks();
  }

  /* -------------------------------------------------------------------------- */
  /* Quick Add Parser with Multi-Tags & Estimates                               */
  /* -------------------------------------------------------------------------- */

  async handleQuickAdd() {
    const input = document.getElementById('quick-add-input');
    const prioritySelect = document.getElementById('quick-priority-select');
    const categorySelect = document.getElementById('quick-category-select');

    if (!input || !input.value.trim()) return;

    let text = input.value.trim();
    let priority = prioritySelect ? prioritySelect.value : 'medium';
    let category = categorySelect ? categorySelect.value : (this.categories[0]?.name || 'General');
    let dueDate = null;
    let tags = [];
    let estimatedMinutes = 0;

    if (/!(urgent|p0)/i.test(text)) {
      priority = 'urgent';
      text = text.replace(/!(urgent|p0)/ig, '').trim();
    } else if (/!(high|p1)/i.test(text)) {
      priority = 'high';
      text = text.replace(/!(high|p1)/ig, '').trim();
    } else if (/!(medium|med|p2)/i.test(text)) {
      priority = 'medium';
      text = text.replace(/!(medium|med|p2)/ig, '').trim();
    } else if (/!(low|p3)/i.test(text)) {
      priority = 'low';
      text = text.replace(/!(low|p3)/ig, '').trim();
    }

    const estMatch = text.match(/~(\d+)(m|h)?/i);
    if (estMatch) {
      const val = parseInt(estMatch[1], 10);
      const unit = estMatch[2] ? estMatch[2].toLowerCase() : 'm';
      estimatedMinutes = unit === 'h' ? val * 60 : val;
      text = text.replace(estMatch[0], '').trim();
    }

    const hashMatches = text.match(/#([a-zA-Z0-9_\-]+)/g);
    if (hashMatches) {
      hashMatches.forEach((hash, idx) => {
        const tag = hash.substring(1);
        const matchCat = this.categories.find(c => c.name.toLowerCase() === tag.toLowerCase());
        if (matchCat && idx === 0) {
          category = matchCat.name;
        } else {
          tags.push(tag.toLowerCase());
        }
        text = text.replace(hash, '').trim();
      });
    }

    let recurrence = 'none';
    if (/@(daily|everyday)/i.test(text)) {
      recurrence = 'daily';
      text = text.replace(/@(daily|everyday)/ig, '').trim();
    } else if (/@weekdays/i.test(text)) {
      recurrence = 'weekdays';
      text = text.replace(/@weekdays/ig, '').trim();
    } else if (/@weekly/i.test(text)) {
      recurrence = 'weekly';
      text = text.replace(/@weekly/ig, '').trim();
    } else if (/@monthly/i.test(text)) {
      recurrence = 'monthly';
      text = text.replace(/@monthly/ig, '').trim();
    } else if (/@yearly/i.test(text)) {
      recurrence = 'yearly';
      text = text.replace(/@yearly/ig, '').trim();
    }

    if (/@today/i.test(text)) {
      dueDate = this.getRelativeDate(0);
      text = text.replace(/@today/ig, '').trim();
    } else if (/@tomorrow/i.test(text)) {
      dueDate = this.getRelativeDate(1);
      text = text.replace(/@tomorrow/ig, '').trim();
    } else {
      const dateMatch = text.match(/@(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        dueDate = dateMatch[1];
        text = text.replace(dateMatch[0], '').trim();
      }
    }

    const newTask = {
      id: 'task-' + Date.now(),
      title: text || 'Untitled Task',
      notes: '',
      category: category,
      priority: priority,
      status: 'todo',
      completed: false,
      completedAt: null,
      dueDate: dueDate || this.getRelativeDate(0),
      dueTime: '',
      tags: tags,
      estimatedMinutes: estimatedMinutes || 30,
      timeSpentMinutes: 0,
      pomodoroSessions: 0,
      subtasks: [],
      starred: false,
      recurrence: recurrence,
      createdAt: new Date().toISOString()
    };

    this.tasks.unshift(newTask);
    this.saveDataLocally();
    input.value = '';
    this.render();

    await this.apiCreateTask(newTask);
  }

  /* -------------------------------------------------------------------------- */
  /* Task CRUD & Actions                                                        */
  /* -------------------------------------------------------------------------- */

  openTaskModal(taskId = null, defaultDate = null) {
    const modal = document.getElementById('task-modal');
    const titleEl = document.getElementById('task-modal-title');
    const idInput = document.getElementById('task-id');
    const titleInput = document.getElementById('task-title-input');
    const notesInput = document.getElementById('task-notes-input');
    const catSelect = document.getElementById('task-category-select');
    const prioSelect = document.getElementById('task-priority-select');
    const tagsInput = document.getElementById('task-tags-input');
    const estInput = document.getElementById('task-estimate-input');
    const dateInput = document.getElementById('task-due-date');
    const timeInput = document.getElementById('task-due-time');
    const recurSelect = document.getElementById('task-recurrence-select');

    this.modalSubtasks = [];
    this.renderCategoryOptions(catSelect);

    if (taskId) {
      const task = this.tasks.find(t => t.id === taskId);
      if (!task) return;
      titleEl.textContent = 'Edit Task';
      idInput.value = task.id;
      titleInput.value = task.title;
      notesInput.value = task.notes || '';
      catSelect.value = task.category || '';
      prioSelect.value = task.priority || 'medium';
      tagsInput.value = (task.tags || []).map(t => '#' + t).join(', ');
      estInput.value = task.estimatedMinutes || '';
      dateInput.value = task.dueDate || '';
      timeInput.value = task.dueTime || '';
      if (recurSelect) recurSelect.value = task.recurrence || 'none';
      this.modalSubtasks = JSON.parse(JSON.stringify(task.subtasks || []));
    } else {
      titleEl.textContent = 'New Task';
      idInput.value = '';
      titleInput.value = '';
      notesInput.value = '';
      catSelect.value = this.categories[0]?.name || '';
      prioSelect.value = 'medium';
      tagsInput.value = '';
      estInput.value = '30';
      dateInput.value = defaultDate || this.getRelativeDate(0);
      timeInput.value = '';
      if (recurSelect) recurSelect.value = 'none';
    }

    this.renderModalSubtasks();
    modal.classList.add('active');
    setTimeout(() => titleInput.focus(), 50);
  }

  addModalSubtask() {
    const input = document.getElementById('new-subtask-input');
    if (!input || !input.value.trim()) return;

    this.modalSubtasks.push({
      id: 'st-' + Date.now(),
      title: input.value.trim(),
      completed: false
    });
    input.value = '';
    this.renderModalSubtasks();
  }

  removeModalSubtask(subtaskId) {
    this.modalSubtasks = this.modalSubtasks.filter(st => st.id !== subtaskId);
    this.renderModalSubtasks();
  }

  renderModalSubtasks() {
    const list = document.getElementById('modal-subtask-list');
    if (!list) return;

    list.innerHTML = this.modalSubtasks.map(st => `
      <div class="subtask-builder-item">
        <span style="flex:1; font-size: 0.85rem;">• ${this.escapeHtml(st.title)}</span>
        <button type="button" class="task-action-btn" onclick="app.removeModalSubtask('${st.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `).join('');
  }

  async handleSaveTask(event) {
    event.preventDefault();
    const id = document.getElementById('task-id').value;
    const title = document.getElementById('task-title-input').value.trim();
    const notes = document.getElementById('task-notes-input').value.trim();
    const category = document.getElementById('task-category-select').value;
    const priority = document.getElementById('task-priority-select').value;
    const tagsRaw = document.getElementById('task-tags-input').value;
    const estVal = parseInt(document.getElementById('task-estimate-input').value, 10);
    const dueDate = document.getElementById('task-due-date').value;
    const dueTime = document.getElementById('task-due-time').value;
    const recurrence = document.getElementById('task-recurrence-select')?.value || 'none';

    if (!title) return;

    const tags = tagsRaw.split(/[, ]+/)
      .map(t => t.replace(/^#/, '').trim().toLowerCase())
      .filter(t => t.length > 0);

    if (id) {
      const task = this.tasks.find(t => t.id === id);
      if (task) {
        task.title = title;
        task.notes = notes;
        task.category = category;
        task.priority = priority;
        task.tags = tags;
        task.estimatedMinutes = isNaN(estVal) ? 0 : estVal;
        task.dueDate = dueDate;
        task.dueTime = dueTime;
        task.recurrence = recurrence;
        task.subtasks = this.modalSubtasks;
        await this.apiUpdateTask(task);
      }
    } else {
      const newTask = {
        id: 'task-' + Date.now(),
        title: title,
        notes: notes,
        category: category,
        priority: priority,
        status: 'todo',
        completed: false,
        completedAt: null,
        dueDate: dueDate,
        dueTime: dueTime,
        tags: tags,
        estimatedMinutes: isNaN(estVal) ? 30 : estVal,
        timeSpentMinutes: 0,
        pomodoroSessions: 0,
        subtasks: this.modalSubtasks,
        starred: false,
        recurrence: recurrence,
        createdAt: new Date().toISOString()
      };
      this.tasks.unshift(newTask);
      await this.apiCreateTask(newTask);
    }

    this.saveDataLocally();
    this.closeModals();
    this.render();
  }

  async toggleTaskComplete(taskId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return;

    task.completed = !task.completed;
    if (task.completed) {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      this.playSuccessChime();
      this.triggerConfetti();

      // Recurring Task Engine: Auto-spawn next occurrence
      if (task.recurrence && task.recurrence !== 'none') {
        const nextDueDate = this.calculateNextRecurringDate(task.dueDate || this.getRelativeDate(0), task.recurrence);
        const recurringCopy = {
          ...JSON.parse(JSON.stringify(task)),
          id: 'task-' + Date.now(),
          completed: false,
          completedAt: null,
          status: 'todo',
          dueDate: nextDueDate,
          timeSpentMinutes: 0,
          pomodoroSessions: 0,
          createdAt: new Date().toISOString(),
          subtasks: (task.subtasks || []).map(st => ({ ...st, completed: false }))
        };

        this.tasks.unshift(recurringCopy);
        await this.apiCreateTask(recurringCopy);
        this.showToast(`🔁 Next recurring task scheduled for ${nextDueDate}`, 'success');
      }
    } else {
      task.status = 'todo';
      task.completedAt = null;
    }

    this.saveDataLocally();
    this.render();
    await this.apiToggleTask(taskId);
  }

  calculateNextRecurringDate(baseDateStr, recurrence) {
    const d = new Date(baseDateStr + 'T12:00:00');
    if (isNaN(d.getTime())) {
      d.setTime(Date.now());
    }

    if (recurrence === 'daily') {
      d.setDate(d.getDate() + 1);
    } else if (recurrence === 'weekdays') {
      do {
        d.setDate(d.getDate() + 1);
      } while (d.getDay() === 0 || d.getDay() === 6); // 0 = Sun, 6 = Sat
    } else if (recurrence === 'weekly') {
      d.setDate(d.getDate() + 7);
    } else if (recurrence === 'biweekly') {
      d.setDate(d.getDate() + 14);
    } else if (recurrence === 'monthly') {
      d.setMonth(d.getMonth() + 1);
    } else if (recurrence === 'yearly') {
      d.setFullYear(d.getFullYear() + 1);
    }

    return d.toISOString().split('T')[0];
  }

  async toggleTaskStar(taskId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.starred = !task.starred;
    this.saveDataLocally();
    this.render();
    await this.apiUpdateTask(task);
  }

  async duplicateTask(taskId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return;

    const copy = JSON.parse(JSON.stringify(task));
    copy.id = 'task-' + Date.now();
    copy.title = copy.title + ' (Copy)';
    copy.completed = false;
    copy.status = 'todo';
    copy.completedAt = null;
    copy.createdAt = new Date().toISOString();

    this.tasks.unshift(copy);
    this.saveDataLocally();
    this.render();
    await this.apiCreateTask(copy);
  }

  async deleteTask(taskId) {
    this.tasks = this.tasks.filter(t => t.id !== taskId);
    if (this.pomoActiveTaskId === taskId) {
      this.pomoActiveTaskId = null;
      this.updatePomodoroDisplay();
    }
    this.saveDataLocally();
    this.render();
    await this.apiDeleteTask(taskId);
  }

  async toggleSubtask(taskId, subtaskId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task || !task.subtasks) return;

    const sub = task.subtasks.find(s => s.id === subtaskId);
    if (sub) {
      sub.completed = !sub.completed;
      this.saveDataLocally();
      this.render();
      await this.apiUpdateTask(task);
    }
  }

  async clearCompletedTasks() {
    const completedTasks = this.tasks.filter(t => t.completed);
    if (completedTasks.length === 0) return;

    if (confirm(`Clear all ${completedTasks.length} completed tasks?`)) {
      this.tasks = this.tasks.filter(t => !t.completed);
      this.saveDataLocally();
      this.render();

      for (const t of completedTasks) {
        await this.apiDeleteTask(t.id);
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Categories & Tags Management                                               */
  /* -------------------------------------------------------------------------- */

  openCategoryModal() {
    document.getElementById('category-name-input').value = '';
    document.getElementById('category-color-input').value = '#10b981';
    document.getElementById('category-modal').classList.add('active');
    setTimeout(() => document.getElementById('category-name-input').focus(), 50);
  }

  async handleSaveCategory(event) {
    event.preventDefault();
    const name = document.getElementById('category-name-input').value.trim();
    const color = document.getElementById('category-color-input').value;

    if (!name) return;

    if (this.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      alert('A category with this name already exists.');
      return;
    }

    const newCat = {
      id: 'cat-' + Date.now(),
      name: name,
      color: color
    };

    this.categories.push(newCat);
    this.saveDataLocally();
    this.closeModals();
    this.render();

    await this.apiCreateCategory(newCat);
  }

  async deleteCategory(categoryName, event) {
    if (event) event.stopPropagation();
    if (this.categories.length <= 1) {
      alert('You must keep at least one category.');
      return;
    }
    if (confirm(`Delete category "${categoryName}"? Existing tasks will be moved to General.`)) {
      const catObj = this.categories.find(c => c.name === categoryName);
      this.categories = this.categories.filter(c => c.name !== categoryName);
      this.tasks.forEach(t => {
        if (t.category === categoryName) {
          t.category = this.categories[0].name;
        }
      });
      if (this.currentFilter === 'cat:' + categoryName) {
        this.currentFilter = 'all';
      }
      this.saveDataLocally();
      this.render();

      if (catObj) {
        await this.apiDeleteCategory(catObj.id);
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Modals Helpers                                                             */
  /* -------------------------------------------------------------------------- */

  closeModals(force = false) {
    document.querySelectorAll('.modal-overlay').forEach(modal => {
      if (modal.id === 'auth-modal' && !force && !this.isAuthenticated()) {
        return; // Do not close auth modal if user is not authenticated
      }
      modal.classList.remove('active');
    });
  }

  openStatsModal() {
    this.updateStatsModalContent();
    document.getElementById('stats-modal').classList.add('active');
  }

  openShortcutsModal() {
    document.getElementById('shortcuts-modal').classList.add('active');
  }

  openDataModal() {
    document.getElementById('data-modal').classList.add('active');
  }

  /* -------------------------------------------------------------------------- */
  /* Drag and Drop (Kanban)                                                     */
  /* -------------------------------------------------------------------------- */

  handleDragStart(event, taskId) {
    this.draggedTaskId = taskId;
    event.dataTransfer.effectAllowed = 'move';
    event.target.classList.add('dragging');
  }

  handleDragEnd(event) {
    event.target.classList.remove('dragging');
    this.draggedTaskId = null;
  }

  handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  async handleDrop(event, newStatus) {
    event.preventDefault();
    if (!this.draggedTaskId) return;

    const task = this.tasks.find(t => t.id === this.draggedTaskId);
    if (task) {
      task.status = newStatus;
      if (newStatus === 'completed') {
        task.completed = true;
        task.completedAt = new Date().toISOString();
        this.playSuccessChime();
        this.triggerConfetti();
      } else {
        task.completed = false;
        task.completedAt = null;
      }
      this.saveDataLocally();
      this.render();
      await this.apiUpdateTask(task);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Filtering & Sorting Engine                                                 */
  /* -------------------------------------------------------------------------- */

  getFilteredTasks() {
    const todayStr = this.getRelativeDate(0);
    const nextWeekStr = this.getRelativeDate(7);

    return this.tasks.filter(task => {
      if (this.currentFilter === 'today') {
        if (task.dueDate !== todayStr) return false;
      } else if (this.currentFilter === 'upcoming') {
        if (!task.dueDate || task.dueDate < todayStr || task.dueDate > nextWeekStr || task.completed) return false;
      } else if (this.currentFilter === 'important') {
        if (!task.starred && task.priority !== 'urgent' && task.priority !== 'high') return false;
      } else if (this.currentFilter === 'overdue') {
        if (!task.dueDate || task.dueDate >= todayStr || task.completed) return false;
      } else if (this.currentFilter === 'completed') {
        if (!task.completed) return false;
      } else if (this.currentFilter.startsWith('cat:')) {
        const catName = this.currentFilter.replace('cat:', '');
        if (task.category !== catName) return false;
      } else if (this.currentFilter.startsWith('tag:')) {
        const tagName = this.currentFilter.replace('tag:', '').toLowerCase();
        if (!(task.tags || []).includes(tagName)) return false;
      }

      if (this.searchQuery) {
        const matchTitle = task.title.toLowerCase().includes(this.searchQuery);
        const matchNotes = (task.notes || '').toLowerCase().includes(this.searchQuery);
        const matchCat = (task.category || '').toLowerCase().includes(this.searchQuery);
        const matchTags = (task.tags || []).some(t => t.toLowerCase().includes(this.searchQuery));
        const matchSub = (task.subtasks || []).some(s => s.title.toLowerCase().includes(this.searchQuery));
        if (!matchTitle && !matchNotes && !matchCat && !matchTags && !matchSub) return false;
      }

      return true;
    }).sort((a, b) => {
      const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1 };

      switch (this.sortBy) {
        case 'due-asc':
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        case 'due-desc':
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return b.dueDate.localeCompare(a.dueDate);
        case 'priority-desc':
          return (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
        case 'priority-asc':
          return (priorityOrder[a.priority] || 0) - (priorityOrder[b.priority] || 0);
        case 'title-asc':
          return a.title.localeCompare(b.title);
        case 'created-desc':
        default:
          return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      }
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Rendering Engine                                                           */
  /* -------------------------------------------------------------------------- */

  render() {
    this.renderCategorySidebar();
    this.renderTagsSidebar();
    this.renderCategoryOptions(document.getElementById('quick-category-select'));
    this.renderSidebarStats();
    this.renderTasks();
  }

  renderCategorySidebar() {
    const list = document.getElementById('category-list');
    if (!list) return;

    list.innerHTML = this.categories.map(cat => {
      const count = this.tasks.filter(t => t.category === cat.name && !t.completed).length;
      const isSelected = this.currentFilter === 'cat:' + cat.name;

      return `
        <li class="nav-item ${isSelected ? 'active' : ''}" data-filter="cat:${cat.name}" onclick="app.setFilter('cat:${cat.name}')">
          <span class="nav-label">
            <span class="category-dot" style="background-color: ${cat.color};"></span>
            ${this.escapeHtml(cat.name)}
          </span>
          <div style="display: flex; align-items: center; gap: 4px;">
            <span class="nav-badge">${count}</span>
            <button class="task-action-btn" title="Delete Category" style="padding: 2px;" onclick="app.deleteCategory('${this.escapeHtml(cat.name)}', event)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </li>
      `;
    }).join('');
  }

  renderTagsSidebar() {
    const container = document.getElementById('sidebar-tags-container');
    const section = document.getElementById('tags-sidebar-section');
    if (!container) return;

    const tagCountMap = {};
    this.tasks.forEach(t => {
      if (!t.completed && Array.isArray(t.tags)) {
        t.tags.forEach(tag => {
          tagCountMap[tag] = (tagCountMap[tag] || 0) + 1;
        });
      }
    });

    const tags = Object.keys(tagCountMap);
    if (tags.length === 0) {
      if (section) section.style.display = 'none';
      return;
    }
    if (section) section.style.display = 'block';

    container.innerHTML = tags.map(tag => {
      const isSelected = this.currentFilter === 'tag:' + tag;
      return `
        <span class="tag-badge ${isSelected ? 'active' : ''}" onclick="app.setFilter('tag:${tag}')">
          #${this.escapeHtml(tag)} <span style="opacity: 0.6; font-size: 0.68rem;">(${tagCountMap[tag]})</span>
        </span>
      `;
    }).join('');
  }

  renderCategoryOptions(selectElement) {
    if (!selectElement) return;
    selectElement.innerHTML = this.categories.map(cat => 
      `<option value="${this.escapeHtml(cat.name)}">${this.escapeHtml(cat.name)}</option>`
    ).join('');
  }

  renderSidebarStats() {
    const total = this.tasks.length;
    const completed = this.tasks.filter(t => t.completed).length;
    const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

    const todayStr = this.getRelativeDate(0);
    const todayCompleted = this.tasks.filter(t => t.completed && t.completedAt && t.completedAt.startsWith(todayStr)).length;

    const todayCount = this.tasks.filter(t => t.dueDate === todayStr && !t.completed).length;
    const upcomingCount = this.tasks.filter(t => t.dueDate && t.dueDate > todayStr && !t.completed).length;
    const importantCount = this.tasks.filter(t => (t.starred || t.priority === 'urgent' || t.priority === 'high') && !t.completed).length;
    const overdueCount = this.tasks.filter(t => t.dueDate && t.dueDate < todayStr && !t.completed).length;

    const countAllEl = document.getElementById('count-all');
    const countTodayEl = document.getElementById('count-today');
    const countUpcomingEl = document.getElementById('count-upcoming');
    const countImportantEl = document.getElementById('count-important');
    const countOverdueEl = document.getElementById('count-overdue');
    const countCompletedEl = document.getElementById('count-completed');

    if (countAllEl) countAllEl.textContent = this.tasks.filter(t => !t.completed).length;
    if (countTodayEl) countTodayEl.textContent = todayCount;
    if (countUpcomingEl) countUpcomingEl.textContent = upcomingCount;
    if (countImportantEl) countImportantEl.textContent = importantCount;
    if (countOverdueEl) countOverdueEl.textContent = overdueCount;
    if (countCompletedEl) countCompletedEl.textContent = completed;

    const percentEl = document.getElementById('sidebar-progress-percent');
    const fillEl = document.getElementById('sidebar-progress-fill');
    const streakEl = document.getElementById('streak-text');

    if (percentEl) percentEl.textContent = `${rate}%`;
    if (fillEl) fillEl.style.width = `${rate}%`;
    if (streakEl) streakEl.textContent = `${todayCompleted} completed today`;
  }

  renderTasks() {
    const tasks = this.getFilteredTasks();
    const countBadge = document.getElementById('task-count-badge');
    if (countBadge) countBadge.textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;

    if (this.currentView === 'list') {
      this.renderListView(tasks);
    } else if (this.currentView === 'kanban') {
      this.renderKanbanView(tasks);
    } else if (this.currentView === 'matrix') {
      this.renderMatrixView(tasks);
    } else if (this.currentView === 'calendar') {
      this.renderCalendarView();
    }
  }

  /* -------------------------------------------------------------------------- */
  /* List View Render                                                           */
  /* -------------------------------------------------------------------------- */

  renderListView(tasks) {
    const container = document.getElementById('task-list');
    if (!container) return;

    if (tasks.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 11l3 3L22 4"></path>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
            </svg>
          </div>
          <div style="font-weight: 700; font-size: 1.1rem; color: var(--text-primary);">No tasks found</div>
          <div style="font-size: 0.85rem;">Enjoy your day or press <span class="kbd-shortcut">N</span> to create a new task.</div>
        </div>
      `;
      return;
    }

    const todayStr = this.getRelativeDate(0);

    container.innerHTML = tasks.map(task => {
      const categoryObj = this.categories.find(c => c.name === task.category);
      const catColor = categoryObj ? categoryObj.color : '#64748b';

      const isOverdue = task.dueDate && task.dueDate < todayStr && !task.completed;
      const isDueToday = task.dueDate === todayStr && !task.completed;
      const isFocusing = this.pomoActiveTaskId === task.id;

      const subtasks = task.subtasks || [];
      const completedSubtasks = subtasks.filter(s => s.completed).length;

      return `
        <div class="task-item ${task.completed ? 'completed' : ''}" id="item-${task.id}">
          <input type="checkbox" class="custom-checkbox" ${task.completed ? 'checked' : ''} onchange="app.toggleTaskComplete('${task.id}')" title="Mark completed">
          
          <div class="task-content">
            <div class="task-header-row">
              <div class="task-title">${this.escapeHtml(task.title)}</div>
              
              <div class="task-actions">
                <button class="btn-focus-task ${isFocusing ? 'active-focus' : ''}" title="Focus on this task with Pomodoro" onclick="app.openPomodoroModal('${task.id}')">
                  <span>🍅</span> ${task.pomodoroSessions ? task.pomodoroSessions + ' 🍅' : 'Focus'}
                </button>
                <button class="task-action-btn star ${task.starred ? 'starred' : ''}" title="Star task" onclick="app.toggleTaskStar('${task.id}')">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="${task.starred ? '#f59e0b' : 'none'}" stroke="currentColor" stroke-width="2">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                  </svg>
                </button>
                <button class="task-action-btn" title="Edit task" onclick="app.openTaskModal('${task.id}')">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                </button>
                <button class="task-action-btn" title="Duplicate task" onclick="app.duplicateTask('${task.id}')">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
                <button class="task-action-btn" title="Delete task" onclick="app.deleteTask('${task.id}')">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            </div>

            ${task.notes ? `<div class="task-notes-markdown">${this.renderMarkdown(task.notes)}</div>` : ''}

            <div class="task-meta-row">
              <span class="task-badge badge-priority-${task.priority}">
                ${task.priority === 'urgent' ? '🔴 Urgent' : task.priority === 'high' ? '🟠 High' : task.priority === 'medium' ? '🟡 Medium' : '🟢 Low'}
              </span>

              <span class="task-badge badge-category">
                <span class="category-dot" style="background-color: ${catColor};"></span>
                ${this.escapeHtml(task.category)}
              </span>

              ${task.dueDate ? `
                <span class="task-badge badge-date ${isOverdue ? 'overdue' : ''} ${isDueToday ? 'due-today' : ''}">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="16" y1="2" x2="16" y2="6"></line>
                    <line x1="8" y1="2" x2="8" y2="6"></line>
                  </svg>
                  ${isOverdue ? '⚠️ Overdue: ' : isDueToday ? '⏰ Today' : ''} ${task.dueDate} ${task.dueTime ? '@ ' + task.dueTime : ''}
                </span>
              ` : ''}

              ${task.estimatedMinutes || task.timeSpentMinutes ? `
                <span class="time-tracker-badge ${isFocusing ? 'active-focus' : ''}">
                  ⏱️ ${task.timeSpentMinutes || 0}m ${task.estimatedMinutes ? '/ ' + task.estimatedMinutes + 'm' : ''}
                </span>
              ` : ''}

              ${task.recurrence && task.recurrence !== 'none' ? `
                <span class="task-badge badge-recurrence" title="Repeats: ${task.recurrence}">
                  🔁 ${task.recurrence.charAt(0).toUpperCase() + task.recurrence.slice(1)}
                </span>
              ` : ''}

              ${(task.tags || []).map(tag => `
                <span class="tag-badge" onclick="app.setFilter('tag:${this.escapeHtml(tag)}')">#${this.escapeHtml(tag)}</span>
              `).join('')}

              ${subtasks.length > 0 ? `
                <span class="task-badge" style="background: var(--bg-surface-hover); color: var(--text-secondary);">
                  ☑️ ${completedSubtasks}/${subtasks.length} subtasks
                </span>
              ` : ''}
            </div>

            ${subtasks.length > 0 ? `
              <div class="subtasks-wrapper">
                <div class="subtasks-list">
                  ${subtasks.map(st => `
                    <label class="subtask-item ${st.completed ? 'completed' : ''}">
                      <input type="checkbox" class="subtask-checkbox" ${st.completed ? 'checked' : ''} onchange="app.toggleSubtask('${task.id}', '${st.id}')">
                      <span>${this.escapeHtml(st.title)}</span>
                    </label>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  /* -------------------------------------------------------------------------- */
  /* Kanban View Render                                                         */
  /* -------------------------------------------------------------------------- */

  renderKanbanView(tasks) {
    const todoList = document.getElementById('kanban-todo-list');
    const inprogressList = document.getElementById('kanban-inprogress-list');
    const completedList = document.getElementById('kanban-completed-list');

    const todoTasks = tasks.filter(t => (!t.status || t.status === 'todo') && !t.completed);
    const inprogressTasks = tasks.filter(t => t.status === 'inprogress' && !t.completed);
    const completedTasks = tasks.filter(t => t.status === 'completed' || t.completed);

    document.getElementById('kanban-todo-count').textContent = todoTasks.length;
    document.getElementById('kanban-inprogress-count').textContent = inprogressTasks.length;
    document.getElementById('kanban-completed-count').textContent = completedTasks.length;

    const renderCard = (task) => {
      const categoryObj = this.categories.find(c => c.name === task.category);
      const catColor = categoryObj ? categoryObj.color : '#64748b';

      return `
        <div class="kanban-card" draggable="true" ondragstart="app.handleDragStart(event, '${task.id}')" ondragend="app.handleDragEnd(event)">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem;">
            <div style="font-weight: 600; font-size: 0.875rem; color: var(--text-primary);">${this.escapeHtml(task.title)}</div>
            <button class="task-action-btn" onclick="app.openTaskModal('${task.id}')" title="Edit">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </button>
          </div>
          ${task.notes ? `<div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.3rem; max-height: 40px; overflow: hidden; text-overflow: ellipsis;">${this.escapeHtml(task.notes)}</div>` : ''}
          <div class="task-meta-row" style="margin-top: 0.5rem;">
            <span class="task-badge badge-priority-${task.priority}" style="font-size: 0.68rem;">
              ${task.priority.toUpperCase()}
            </span>
            <span class="task-badge badge-category" style="font-size: 0.68rem;">
              <span class="category-dot" style="background-color: ${catColor};"></span>
              ${this.escapeHtml(task.category)}
            </span>
            ${(task.tags || []).slice(0, 2).map(tag => `
              <span class="tag-badge" style="font-size: 0.68rem;">#${this.escapeHtml(tag)}</span>
            `).join('')}
          </div>
        </div>
      `;
    };

    if (todoList) todoList.innerHTML = todoTasks.map(renderCard).join('');
    if (inprogressList) inprogressList.innerHTML = inprogressTasks.map(renderCard).join('');
    if (completedList) completedList.innerHTML = completedTasks.map(renderCard).join('');
  }

  /* -------------------------------------------------------------------------- */
  /* Matrix View Render                                                         */
  /* -------------------------------------------------------------------------- */

  renderMatrixView(tasks) {
    const activeTasks = tasks.filter(t => !t.completed);

    const q1Tasks = activeTasks.filter(t => t.priority === 'urgent');
    const q2Tasks = activeTasks.filter(t => t.priority === 'high' || (t.starred && t.priority !== 'urgent'));
    const q3Tasks = activeTasks.filter(t => t.priority === 'medium');
    const q4Tasks = activeTasks.filter(t => t.priority === 'low');

    document.getElementById('matrix-q1-count').textContent = q1Tasks.length;
    document.getElementById('matrix-q2-count').textContent = q2Tasks.length;
    document.getElementById('matrix-q3-count').textContent = q3Tasks.length;
    document.getElementById('matrix-q4-count').textContent = q4Tasks.length;

    const renderMatrixItems = (list) => {
      if (list.length === 0) return `<div style="font-size: 0.78rem; color: var(--text-muted); padding: 0.5rem 0;">No tasks in this quadrant</div>`;
      return list.map(t => `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.4rem 0.6rem; background: var(--bg-surface); border-radius: 6px; border: 1px solid var(--border-subtle); font-size: 0.825rem;">
          <span style="font-weight: 500;">${this.escapeHtml(t.title)}</span>
          <input type="checkbox" class="custom-checkbox" style="width: 16px; height: 16px;" onchange="app.toggleTaskComplete('${t.id}')">
        </div>
      `).join('');
    };

    document.getElementById('matrix-q1-list').innerHTML = renderMatrixItems(q1Tasks);
    document.getElementById('matrix-q2-list').innerHTML = renderMatrixItems(q2Tasks);
    document.getElementById('matrix-q3-list').innerHTML = renderMatrixItems(q3Tasks);
    document.getElementById('matrix-q4-list').innerHTML = renderMatrixItems(q4Tasks);
  }

  /* -------------------------------------------------------------------------- */
  /* Analytics Modal                                                            */
  /* -------------------------------------------------------------------------- */

  updateStatsModalContent() {
    const total = this.tasks.length;
    const completed = this.tasks.filter(t => t.completed).length;
    const pending = total - completed;
    const todayStr = this.getRelativeDate(0);
    const overdue = this.tasks.filter(t => t.dueDate && t.dueDate < todayStr && !t.completed).length;
    const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

    document.getElementById('stats-total').textContent = total;
    document.getElementById('stats-completed').textContent = completed;
    document.getElementById('stats-pending').textContent = pending;
    document.getElementById('stats-overdue').textContent = overdue;
    document.getElementById('stats-rate').textContent = `${rate}%`;
    document.getElementById('stats-rate-fill').style.width = `${rate}%`;

    const priorities = ['urgent', 'high', 'medium', 'low'];
    const breakdownEl = document.getElementById('stats-priority-breakdown');
    if (breakdownEl) {
      breakdownEl.innerHTML = priorities.map(p => {
        const count = this.tasks.filter(t => t.priority === p).length;
        const pPercent = total > 0 ? Math.round((count / total) * 100) : 0;
        const labels = { urgent: '🔴 Urgent', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' };

        return `
          <div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
              <span>${labels[p]}</span>
              <span style="color: var(--text-secondary);">${count} tasks (${pPercent}%)</span>
            </div>
            <div class="progress-bar-container" style="height: 6px;">
              <div class="progress-bar-fill" style="width: ${pPercent}%;"></div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Data Export / Import                                                       */
  /* -------------------------------------------------------------------------- */

  exportData(format) {
    if (format === 'json') {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({
        user: this.currentUser,
        tasks: this.tasks,
        categories: this.categories,
        exportedAt: new Date().toISOString()
      }, null, 2));

      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `taskflow_${this.currentUser.username}_backup_${this.getRelativeDate(0)}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    } else if (format === 'csv') {
      const headers = ['ID', 'Title', 'Category', 'Priority', 'Status', 'Completed', 'DueDate', 'Tags', 'EstimatedMins', 'TimeSpentMins', 'Notes'];
      const rows = this.tasks.map(t => [
        t.id,
        `"${(t.title || '').replace(/"/g, '""')}"`,
        `"${(t.category || '').replace(/"/g, '""')}"`,
        t.priority,
        t.status,
        t.completed ? 'Yes' : 'No',
        t.dueDate || '',
        `"${(t.tags || []).join(';')}"`,
        t.estimatedMinutes || 0,
        t.timeSpentMinutes || 0,
        `"${(t.notes || '').replace(/"/g, '""')}"`
      ]);

      const csvContent = "data:text/csv;charset=utf-8," + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", encodeURI(csvContent));
      downloadAnchor.setAttribute("download", `taskflow_tasks_${this.getRelativeDate(0)}.csv`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    }
  }

  importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (Array.isArray(parsed.tasks)) {
          this.tasks = parsed.tasks;
          if (Array.isArray(parsed.categories)) {
            this.categories = parsed.categories;
          }
          this.saveDataLocally();
          await fetch(`${this.API_BASE}/sync`, {
            method: 'POST',
            headers: this.getAuthHeaders(),
            body: JSON.stringify({
              tasks: this.tasks,
              categories: this.categories
            })
          });
          this.closeModals();
          this.render();
          alert('Data imported successfully into your account!');
        } else {
          alert('Invalid backup file format.');
        }
      } catch (err) {
        alert('Failed to parse JSON file.');
      }
    };
    reader.readAsText(file);
  }

  /* -------------------------------------------------------------------------- */
  /* Utility                                                                    */
  /* -------------------------------------------------------------------------- */

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* -------------------------------------------------------------------------- */
  /* Toast Notification Engine                                                  */
  /* -------------------------------------------------------------------------- */

  showToast(message, type = 'success', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✅' : type === 'info' ? 'ℹ️' : '⚠️';
    toast.innerHTML = `<span>${icon}</span><span>${this.escapeHtml(message)}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px) scale(0.96)';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  /* -------------------------------------------------------------------------- */
  /* Interactive Calendar View Engine                                           */
  /* -------------------------------------------------------------------------- */

  calendarPrev() {
    if (this.calendarMode === 'month') {
      this.calendarDate.setMonth(this.calendarDate.getMonth() - 1);
    } else {
      this.calendarDate.setDate(this.calendarDate.getDate() - 7);
    }
    this.renderCalendarView();
  }

  calendarNext() {
    if (this.calendarMode === 'month') {
      this.calendarDate.setMonth(this.calendarDate.getMonth() + 1);
    } else {
      this.calendarDate.setDate(this.calendarDate.getDate() + 7);
    }
    this.renderCalendarView();
  }

  calendarToday() {
    this.calendarDate = new Date();
    this.renderCalendarView();
  }

  setCalendarMode(mode) {
    this.calendarMode = mode;
    const mBtn = document.getElementById('cal-mode-month');
    const wBtn = document.getElementById('cal-mode-week');
    if (mBtn) mBtn.classList.toggle('active', mode === 'month');
    if (wBtn) wBtn.classList.toggle('active', mode === 'week');
    this.renderCalendarView();
  }

  renderCalendarView() {
    const headerTitle = document.getElementById('calendar-header-title');
    const wrapper = document.getElementById('calendar-wrapper');
    if (!wrapper) return;

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const year = this.calendarDate.getFullYear();
    const month = this.calendarDate.getMonth();

    if (this.calendarMode === 'month') {
      if (headerTitle) headerTitle.textContent = `${monthNames[month]} ${year}`;
      this.renderMonthGrid(wrapper, year, month);
    } else {
      const startOfWeek = new Date(this.calendarDate);
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(endOfWeek.getDate() + 6);
      
      const startStr = `${monthNames[startOfWeek.getMonth()].substring(0, 3)} ${startOfWeek.getDate()}`;
      const endStr = `${monthNames[endOfWeek.getMonth()].substring(0, 3)} ${endOfWeek.getDate()}, ${endOfWeek.getFullYear()}`;
      if (headerTitle) headerTitle.textContent = `${startStr} – ${endStr}`;
      this.renderWeekGrid(wrapper, startOfWeek);
    }
  }

  renderMonthGrid(container, year, month) {
    const todayStr = this.getRelativeDate(0);
    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    let gridHtml = `
      <div class="calendar-grid">
        <div class="cal-header-cell">Sun</div>
        <div class="cal-header-cell">Mon</div>
        <div class="cal-header-cell">Tue</div>
        <div class="cal-header-cell">Wed</div>
        <div class="cal-header-cell">Thu</div>
        <div class="cal-header-cell">Fri</div>
        <div class="cal-header-cell">Sat</div>
    `;

    // 1. Prev Month Leading Days
    for (let x = firstDayIndex; x > 0; x--) {
      const dayNum = prevMonthDays - x + 1;
      const prevDate = new Date(year, month - 1, dayNum);
      const dateStr = prevDate.toISOString().split('T')[0];
      gridHtml += this.renderCalendarDayCell(dateStr, dayNum, true, todayStr);
    }

    // 2. Current Month Days
    for (let d = 1; d <= totalDaysInMonth; d++) {
      const currentDate = new Date(year, month, d);
      const dateStr = currentDate.toISOString().split('T')[0];
      gridHtml += this.renderCalendarDayCell(dateStr, d, false, todayStr);
    }

    // 3. Next Month Trailing Days
    const totalCells = firstDayIndex + totalDaysInMonth;
    const remainingCells = (7 - (totalCells % 7)) % 7;
    for (let y = 1; y <= remainingCells; y++) {
      const nextDate = new Date(year, month + 1, y);
      const dateStr = nextDate.toISOString().split('T')[0];
      gridHtml += this.renderCalendarDayCell(dateStr, y, true, todayStr);
    }

    gridHtml += `</div>`;
    container.innerHTML = gridHtml;
  }

  renderCalendarDayCell(dateStr, dayNum, isOtherMonth, todayStr) {
    const isToday = dateStr === todayStr;
    const dayTasks = this.tasks.filter(t => t.dueDate === dateStr);

    return `
      <div class="cal-day-cell ${isOtherMonth ? 'other-month' : ''} ${isToday ? 'is-today' : ''}" 
           data-date="${dateStr}"
           ondragover="app.handleCalendarDragOver(event)"
           ondragleave="app.handleCalendarDragLeave(event)"
           ondrop="app.handleCalendarDrop(event, '${dateStr}')">
        <div class="cal-day-top">
          <span class="cal-day-number">${dayNum}</span>
          <button class="cal-add-btn" title="Add task on ${dateStr}" onclick="app.openTaskModal(null, '${dateStr}')">+</button>
        </div>
        <div class="cal-tasks-list">
          ${dayTasks.map(t => {
            const priorityDot = t.priority === 'urgent' ? '🔴' : t.priority === 'high' ? '🟠' : t.priority === 'medium' ? '🟡' : '🟢';
            const recurIcon = (t.recurrence && t.recurrence !== 'none') ? ' 🔁' : '';
            return `
              <div class="cal-task-pill ${t.completed ? 'completed' : ''}" 
                   draggable="true" 
                   ondragstart="app.handleCalendarDragStart(event, '${t.id}')"
                   onclick="app.openTaskModal('${t.id}')"
                   title="${this.escapeHtml(t.title)}${t.priority ? ' (' + t.priority + ')' : ''}">
                <span>${priorityDot}</span>
                <span class="cal-task-pill-title">${this.escapeHtml(t.title)}</span>
                ${recurIcon}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  renderWeekGrid(container, startOfWeek) {
    const todayStr = this.getRelativeDate(0);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let html = `<div class="calendar-week-grid">`;
    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfWeek);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      const isToday = dateStr === todayStr;
      const dayTasks = this.tasks.filter(t => t.dueDate === dateStr);

      html += `
        <div class="cal-week-col ${isToday ? 'is-today' : ''}"
             data-date="${dateStr}"
             ondragover="app.handleCalendarDragOver(event)"
             ondragleave="app.handleCalendarDragLeave(event)"
             ondrop="app.handleCalendarDrop(event, '${dateStr}')">
          <div class="cal-week-header">
            <div class="cal-week-day-name">${dayNames[i]}</div>
            <div class="cal-week-day-num">${d.getDate()}</div>
            <button class="btn btn-outline btn-sm" style="margin-top: 0.3rem; width: 100%; font-size: 0.72rem; padding: 0.2rem;" onclick="app.openTaskModal(null, '${dateStr}')">+ Add Task</button>
          </div>
          <div class="cal-tasks-list" style="max-height: none; flex: 1;">
            ${dayTasks.map(t => {
              const priorityDot = t.priority === 'urgent' ? '🔴' : t.priority === 'high' ? '🟠' : t.priority === 'medium' ? '🟡' : '🟢';
              const recurIcon = (t.recurrence && t.recurrence !== 'none') ? ' 🔁' : '';
              return `
                <div class="cal-task-pill ${t.completed ? 'completed' : ''}" 
                     draggable="true" 
                     ondragstart="app.handleCalendarDragStart(event, '${t.id}')"
                     onclick="app.openTaskModal('${t.id}')"
                     title="${this.escapeHtml(t.title)}">
                  <span>${priorityDot}</span>
                  <span class="cal-task-pill-title">${this.escapeHtml(t.title)}</span>
                  ${recurIcon}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }
    html += `</div>`;
    container.innerHTML = html;
  }

  handleCalendarDragStart(event, taskId) {
    this.calDraggedTaskId = taskId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', taskId);
  }

  handleCalendarDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const cell = event.currentTarget;
    if (cell && !cell.classList.contains('drag-over')) {
      cell.classList.add('drag-over');
    }
  }

  handleCalendarDragLeave(event) {
    const cell = event.currentTarget;
    if (cell) {
      cell.classList.remove('drag-over');
    }
  }

  async handleCalendarDrop(event, targetDateStr) {
    event.preventDefault();
    const cell = event.currentTarget;
    if (cell) cell.classList.remove('drag-over');

    const taskId = this.calDraggedTaskId || event.dataTransfer.getData('text/plain');
    if (!taskId || !targetDateStr) return;

    const task = this.tasks.find(t => t.id === taskId);
    if (!task || task.dueDate === targetDateStr) return;

    task.dueDate = targetDateStr;
    this.saveDataLocally();
    this.render();
    await this.apiUpdateTask(task);
    this.showToast(`📅 Task rescheduled to ${targetDateStr}`, 'info');
  }

}


// Global initialization
window.app = new TaskFlowApp();
