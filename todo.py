#!/usr/bin/env python3
"""
TaskFlow CLI Companion
Manage tasks directly from your terminal.
"""

import sys
import os
import json
import sqlite3
import argparse
from datetime import datetime, timedelta

DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.db")

# Terminal ANSI colors
GREEN = "\033[92m"
BLUE = "\033[94m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def get_connection():
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
    conn.commit()
    return conn


def get_priority_tag(priority):
    p = (priority or "medium").lower()
    if p == "urgent":
        return f"{RED}[URGENT]{RESET}"
    elif p == "high":
        return f"{YELLOW}[HIGH]{RESET}"
    elif p == "medium":
        return f"{BLUE}[MED]{RESET}"
    else:
        return f"{DIM}[LOW]{RESET}"


def add_task(title, category="General", priority="medium", due_date=None, notes=""):
    conn = get_connection()
    cursor = conn.cursor()
    task_id = f"task-{int(datetime.now().timestamp() * 1000)}"
    created_at = datetime.now().isoformat()

    cursor.execute("""
        INSERT INTO tasks (id, title, notes, category, priority, status, completed, completed_at, due_date, due_time, subtasks, starred, created_at)
        VALUES (?, ?, ?, ?, ?, 'todo', 0, NULL, ?, '', '[]', 0, ?)
    """, (task_id, title, notes, category, priority.lower(), due_date or datetime.now().strftime("%Y-%m-%d"), created_at))
    conn.commit()
    conn.close()

    print(f"\n{GREEN}✔ Created task:{RESET} {BOLD}{title}{RESET}")
    print(f"  ID: {task_id} | Priority: {get_priority_tag(priority)} | Category: {category} | Due: {due_date or 'Today'}\n")


def list_tasks(show_all=False, today_only=False, category=None, priority=None):
    conn = get_connection()
    cursor = conn.cursor()

    query = "SELECT id, title, category, priority, completed, due_date, notes FROM tasks WHERE 1=1"
    params = []

    if not show_all:
        query += " AND completed = 0"
    if today_only:
        today_str = datetime.now().strftime("%Y-%m-%d")
        query += " AND due_date = ?"
        params.append(today_str)
    if category:
        query += " AND lower(category) = lower(?)"
        params.append(category)
    if priority:
        query += " AND lower(priority) = lower(?)"
        params.append(priority)

    query += " ORDER BY completed ASC, due_date ASC, priority DESC"

    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        print(f"\n{YELLOW}No tasks found matching criteria.{RESET}\n")
        return

    print(f"\n{BOLD}TaskFlow Tasks{RESET} ({len(rows)} item{'s' if len(rows) != 1 else ''}):")
    print("-" * 75)
    print(f"{'Status':<8} {'ID':<18} {'Priority':<12} {'Due Date':<12} {'Category':<12} {'Title'}")
    print("-" * 75)

    for r in rows:
        tid, title, cat, prio, comp, due, notes = r
        status_symbol = f"{GREEN}✔ DONE{RESET}" if comp else f"{YELLOW}○ TODO{RESET}"
        prio_tag = get_priority_tag(prio)
        due_str = due or "-"
        cat_str = cat or "General"

        # Highlight overdue
        today_str = datetime.now().strftime("%Y-%m-%d")
        if due and due < today_str and not comp:
            due_str = f"{RED}{due} (Overdue){RESET}"

        print(f"{status_symbol:<17} {tid[:16]:<18} {prio_tag:<21} {due_str:<12} {cat_str:<12} {title}")

    print("-" * 75 + "\n")


def complete_task(identifier):
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT id, title FROM tasks WHERE id = ? OR id LIKE ? OR title LIKE ?", (identifier, f"%{identifier}%", f"%{identifier}%"))
    row = cursor.fetchone()

    if not row:
        print(f"{RED}Error: Task not found matching '{identifier}'{RESET}")
        conn.close()
        return

    tid, title = row
    completed_at = datetime.now().isoformat()
    cursor.execute("UPDATE tasks SET completed = 1, status = 'completed', completed_at = ? WHERE id = ?", (completed_at, tid))
    conn.commit()
    conn.close()

    print(f"{GREEN}✔ Task marked as completed:{RESET} {BOLD}{title}{RESET} ({tid})")


def delete_task(identifier):
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT id, title FROM tasks WHERE id = ? OR id LIKE ? OR title LIKE ?", (identifier, f"%{identifier}%", f"%{identifier}%"))
    row = cursor.fetchone()

    if not row:
        print(f"{RED}Error: Task not found matching '{identifier}'{RESET}")
        conn.close()
        return

    tid, title = row
    cursor.execute("DELETE FROM tasks WHERE id = ?", (tid,))
    conn.commit()
    conn.close()

    print(f"{YELLOW}🗑️ Task deleted:{RESET} {title} ({tid})")


def show_stats():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT count(*), sum(completed) FROM tasks")
    total, completed = cursor.fetchone()
    total = total or 0
    completed = completed or 0
    pending = total - completed
    rate = round((completed / total * 100), 1) if total > 0 else 0

    print(f"\n{BOLD}📊 TaskFlow Productivity Analytics{RESET}")
    print("=" * 40)
    print(f"  Total Tasks:      {BOLD}{total}{RESET}")
    print(f"  Completed:        {GREEN}{completed}{RESET}")
    print(f"  Pending:          {YELLOW}{pending}{RESET}")
    print(f"  Completion Rate:  {BOLD}{rate}%{RESET}")
    print("=" * 40 + "\n")
    conn.close()


def main():
    parser = argparse.ArgumentParser(description="TaskFlow CLI - Productivity Task Manager")
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # add
    add_p = subparsers.add_parser("add", help="Add a new task")
    add_p.add_argument("title", help="Task title")
    add_p.add_argument("-c", "--category", default="General", help="Category name")
    add_p.add_argument("-p", "--priority", choices=["urgent", "high", "medium", "low"], default="medium", help="Priority level")
    add_p.add_argument("-d", "--due", help="Due date (YYYY-MM-DD)")
    add_p.add_argument("-n", "--notes", default="", help="Description or notes")

    # list
    list_p = subparsers.add_parser("list", help="List tasks")
    list_p.add_argument("-a", "--all", action="store_true", help="Include completed tasks")
    list_p.add_argument("-t", "--today", action="store_true", help="Show today's tasks only")
    list_p.add_argument("-c", "--category", help="Filter by category")
    list_p.add_argument("-p", "--priority", help="Filter by priority")

    # done
    done_p = subparsers.add_parser("done", help="Mark task as complete")
    done_p.add_argument("id", help="Task ID or matching title keyword")

    # delete
    del_p = subparsers.add_parser("delete", help="Delete task")
    del_p.add_argument("id", help="Task ID or matching title keyword")

    # stats
    subparsers.add_parser("stats", help="Show productivity statistics")

    # web
    subparsers.add_parser("web", help="Launch TaskFlow web app")

    args = parser.parse_args()

    if args.command == "add":
        add_task(args.title, args.category, args.priority, args.due, args.notes)
    elif args.command == "list" or not args.command:
        if not args.command:
            list_tasks()
        else:
            list_tasks(args.all, args.today, args.category, args.priority)
    elif args.command == "done":
        complete_task(args.id)
    elif args.command == "delete":
        delete_task(args.id)
    elif args.command == "stats":
        show_stats()
    elif args.command == "web":
        from server import run_server
        run_server()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
