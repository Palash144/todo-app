#!/usr/bin/env python3
"""
TaskFlow Local Backend Server
Serves static frontend files and provides a local REST API backed by SQLite.
Zero external dependencies required (uses Python standard library).
"""

import http.server
import socketserver
import json
import sqlite3
import os
import sys
import webbrowser
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", 8000))
DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.db")
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))


def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            notes TEXT,
            category TEXT,
            priority TEXT,
            status TEXT,
            completed INTEGER,
            completed_at TEXT,
            due_date TEXT,
            due_time TEXT,
            subtasks TEXT,
            starred INTEGER,
            created_at TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


class TaskFlowHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api_get(parsed)
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api_post(parsed)
        else:
            self.send_error(404, "Endpoint not found")

    def handle_api_get(self, parsed):
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()

        if parsed.path == "/api/tasks":
            cursor.execute("SELECT * FROM tasks ORDER BY created_at DESC")
            rows = cursor.fetchall()
            tasks = []
            for r in rows:
                tasks.append({
                    "id": r[0],
                    "title": r[1],
                    "notes": r[2],
                    "category": r[3],
                    "priority": r[4],
                    "status": r[5],
                    "completed": bool(r[6]),
                    "completedAt": r[7],
                    "dueDate": r[8],
                    "dueTime": r[9],
                    "subtasks": json.loads(r[10]) if r[10] else [],
                    "starred": bool(r[11]),
                    "createdAt": r[12]
                })
            self.send_json_response({"tasks": tasks})

        elif parsed.path == "/api/categories":
            cursor.execute("SELECT id, name, color FROM categories")
            rows = cursor.fetchall()
            categories = [{"id": r[0], "name": r[1], "color": r[2]} for r in rows]
            self.send_json_response({"categories": categories})

        elif parsed.path == "/api/stats":
            cursor.execute("SELECT count(*), sum(completed) FROM tasks")
            total, completed = cursor.fetchone()
            total = total or 0
            completed = completed or 0
            self.send_json_response({
                "total": total,
                "completed": completed,
                "pending": total - completed,
                "rate": round((completed / total * 100), 1) if total > 0 else 0
            })
        else:
            self.send_error(404, "API route not found")

        conn.close()

    def handle_api_post(self, parsed):
        content_len = int(self.headers.get("Content-Length", 0))
        post_body = self.rfile.read(content_len).decode("utf-8")
        data = json.loads(post_body) if post_body else {}

        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()

        if parsed.path == "/api/tasks/sync":
            tasks = data.get("tasks", [])
            cursor.execute("DELETE FROM tasks")
            for t in tasks:
                cursor.execute("""
                    INSERT OR REPLACE INTO tasks 
                    (id, title, notes, category, priority, status, completed, completed_at, due_date, due_time, subtasks, starred, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    t.get("id"),
                    t.get("title"),
                    t.get("notes", ""),
                    t.get("category", "General"),
                    t.get("priority", "medium"),
                    t.get("status", "todo"),
                    1 if t.get("completed") else 0,
                    t.get("completedAt"),
                    t.get("dueDate"),
                    t.get("dueTime"),
                    json.dumps(t.get("subtasks", [])),
                    1 if t.get("starred") else 0,
                    t.get("createdAt")
                ))
            conn.commit()
            self.send_json_response({"success": True, "syncedCount": len(tasks)})
        else:
            self.send_error(404, "API route not found")

        conn.close()

    def send_json_response(self, data, status_code=200):
        response_bytes = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(response_bytes)


def run_server():
    init_db()
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), TaskFlowHandler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"\n========================================================")
        print(f"🚀 TaskFlow Server is running at: {url}")
        print(f"📁 Root directory: {STATIC_DIR}")
        print(f"⚡ Press Ctrl+C to stop the server.")
        print(f"========================================================\n")
        
        # Try to open in default browser automatically
        if "--no-browser" not in sys.argv:
            try:
                webbrowser.open(url)
            except Exception:
                pass

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down TaskFlow server...")
            httpd.server_close()


if __name__ == "__main__":
    run_server()
