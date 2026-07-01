from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

JST = timezone(timedelta(hours=9))
DB_PATH = Path(os.environ.get("DATABASE_URL", "festival.db").replace("sqlite:///", ""))
PLANETARIUM_UNIT_PRICE = int(os.environ.get("PLANETARIUM_UNIT_PRICE", "0"))


def now() -> str:
    return datetime.now(JST).isoformat(timespec="seconds")


def new_id() -> str:
    return str(uuid.uuid4())


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000)
    return salt, digest.hex()


def verify_password(password: str, salt: str, password_hash: str) -> bool:
    _, candidate = hash_password(password, salt)
    return secrets.compare_digest(candidate, password_hash)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def log_operation(
    conn: sqlite3.Connection,
    *,
    user_id: str | None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    request: Request | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO user_operation_logs
          (id, user_id, action, target_type, target_id, ip_address, user_agent, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            new_id(),
            user_id,
            action,
            target_type,
            target_id,
            request.client.host if request and request.client else None,
            request.headers.get("user-agent") if request else None,
            json.dumps(metadata or {}, ensure_ascii=False),
            now(),
        ),
    )


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS roles (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL UNIQUE,
              description TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS permissions (
              id TEXT PRIMARY KEY,
              code TEXT NOT NULL UNIQUE,
              description TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS role_permissions (
              role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
              permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
              PRIMARY KEY (role_id, permission_id)
            );
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              role_id TEXT NOT NULL REFERENCES roles(id),
              login_id TEXT NOT NULL UNIQUE,
              password_salt TEXT NOT NULL,
              password_hash TEXT NOT NULL,
              display_name TEXT NOT NULL,
              email TEXT,
              is_active INTEGER NOT NULL DEFAULT 1,
              last_login_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auth_tokens (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              token_hash TEXT NOT NULL UNIQUE,
              expires_at TEXT NOT NULL,
              revoked_at TEXT,
              ip_address TEXT,
              user_agent TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS menu_items (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              price INTEGER NOT NULL,
              is_active INTEGER NOT NULL DEFAULT 1,
              sale_stopped INTEGER NOT NULL DEFAULT 0,
              sold_out INTEGER NOT NULL DEFAULT 0,
              is_hidden INTEGER NOT NULL DEFAULT 0,
              remaining_count INTEGER,
              default_immediate INTEGER NOT NULL DEFAULT 1,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS menu_item_options (
              id TEXT PRIMARY KEY,
              menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              price_delta INTEGER NOT NULL DEFAULT 0,
              is_active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stall_orders (
              id TEXT PRIMARY KEY,
              order_no TEXT NOT NULL UNIQUE,
              call_no TEXT,
              created_by_user_id TEXT NOT NULL REFERENCES users(id),
              status TEXT NOT NULL,
              total_amount INTEGER NOT NULL,
              paid_amount INTEGER NOT NULL,
              payment_method TEXT NOT NULL,
              note TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              served_at TEXT,
              cancelled_at TEXT
            );
            CREATE TABLE IF NOT EXISTS stall_order_items (
              id TEXT PRIMARY KEY,
              order_id TEXT NOT NULL REFERENCES stall_orders(id) ON DELETE CASCADE,
              menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
              item_name TEXT NOT NULL,
              unit_price INTEGER NOT NULL,
              quantity INTEGER NOT NULL,
              line_total INTEGER NOT NULL,
              is_immediate INTEGER NOT NULL,
              status TEXT NOT NULL,
              provided_at TEXT
            );
            CREATE TABLE IF NOT EXISTS stall_order_item_options (
              id TEXT PRIMARY KEY,
              order_item_id TEXT NOT NULL REFERENCES stall_order_items(id) ON DELETE CASCADE,
              option_id TEXT REFERENCES menu_item_options(id),
              option_name TEXT NOT NULL,
              price_delta INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS planetarium_slots (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              starts_at TEXT NOT NULL,
              ends_at TEXT NOT NULL,
              capacity INTEGER NOT NULL,
              reserved_count INTEGER NOT NULL DEFAULT 0,
              is_active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS planetarium_reservations (
              id TEXT PRIMARY KEY,
              slot_id TEXT NOT NULL REFERENCES planetarium_slots(id) ON DELETE CASCADE,
              reservation_no TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              contact_type TEXT NOT NULL,
              contact_value TEXT NOT NULL,
              people_count INTEGER NOT NULL,
              created_by_user_id TEXT REFERENCES users(id),
              revenue_amount INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              checked_in_at TEXT,
              cancelled_at TEXT,
              UNIQUE (slot_id, contact_type, contact_value)
            );
            CREATE TABLE IF NOT EXISTS user_operation_logs (
              id TEXT PRIMARY KEY,
              user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
              action TEXT NOT NULL,
              target_type TEXT,
              target_id TEXT,
              ip_address TEXT,
              user_agent TEXT,
              metadata TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL
            );
            """
        )
        ensure_column(conn, "menu_items", "sale_stopped", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(conn, "menu_items", "sold_out", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(conn, "menu_items", "is_hidden", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(conn, "menu_items", "remaining_count", "INTEGER")
        ensure_column(conn, "planetarium_reservations", "created_by_user_id", "TEXT REFERENCES users(id)")
        ensure_column(conn, "planetarium_reservations", "revenue_amount", "INTEGER NOT NULL DEFAULT 0")
        seed(conn)


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def seed(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT COUNT(*) FROM roles").fetchone()[0] > 0:
        return

    role_ids = {"admin": new_id(), "staff": new_id(), "viewer": new_id()}
    for name, description in [
        ("admin", "全体管理"),
        ("staff", "注文受付と予約確認"),
        ("viewer", "閲覧のみ"),
    ]:
        conn.execute(
            "INSERT INTO roles VALUES (?, ?, ?, ?, ?)",
            (role_ids[name], name, description, now(), now()),
        )

    permission_codes = [
        "users:read",
        "users:write",
        "orders:read",
        "orders:write",
        "orders:serve",
        "reservations:read",
        "reservations:write",
        "slots:write",
        "logs:read",
    ]
    permission_ids: dict[str, str] = {}
    for code in permission_codes:
        permission_ids[code] = new_id()
        conn.execute(
            "INSERT INTO permissions VALUES (?, ?, ?, ?)",
            (permission_ids[code], code, code, now()),
        )

    role_permissions = {
        "admin": permission_codes,
        "staff": [
            "orders:read",
            "orders:write",
            "orders:serve",
            "reservations:read",
            "reservations:write",
        ],
        "viewer": ["orders:read", "reservations:read"],
    }
    for role, codes in role_permissions.items():
        for code in codes:
            conn.execute(
                "INSERT INTO role_permissions VALUES (?, ?)",
                (role_ids[role], permission_ids[code]),
            )

    for login_id, password, display_name, role in [
        ("admin", "admin1234", "管理者", "admin"),
        ("staff", "staff1234", "スタッフ", "staff"),
    ]:
        salt, password_hash = hash_password(password)
        conn.execute(
            """
            INSERT INTO users
              (id, role_id, login_id, password_salt, password_hash, display_name, email,
               is_active, last_login_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
            """,
            (new_id(), role_ids[role], login_id, salt, password_hash, display_name, None, now(), now()),
        )

    menu_data = [
        ("星空焼きそば", 400, 0, ["マヨネーズ抜き", "青のり多め"]),
        ("月面フランク", 300, 1, ["ケチャップ抜き", "からし追加"]),
        ("銀河ソーダ", 250, 1, ["氷なし", "炭酸弱め"]),
        ("観測セット", 600, 0, ["箸多め", "袋あり"]),
    ]
    for index, (name, price, immediate, options) in enumerate(menu_data, start=1):
        item_id = new_id()
        conn.execute(
            """
            INSERT INTO menu_items
              (id, name, price, is_active, sale_stopped, sold_out, is_hidden,
               remaining_count, default_immediate, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, 1, 0, 0, 0, NULL, ?, ?, ?, ?)
            """,
            (item_id, name, price, immediate, index, now(), now()),
        )
        for option in options:
            conn.execute(
                "INSERT INTO menu_item_options VALUES (?, ?, ?, 0, 1, ?)",
                (new_id(), item_id, option, now()),
            )

    base = datetime(2026, 9, 20, 9, 30, tzinfo=JST)
    for index in range(6):
        starts = base + timedelta(minutes=70 * index)
        ends = starts + timedelta(minutes=45)
        conn.execute(
            "INSERT INTO planetarium_slots VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)",
            (
                new_id(),
                f"第{index + 1}回 星空解説",
                starts.isoformat(timespec="seconds"),
                ends.isoformat(timespec="seconds"),
                24,
                now(),
                now(),
            ),
        )


class LoginRequest(BaseModel):
    login_id: str
    password: str


class OrderItemRequest(BaseModel):
    menu_item_id: str
    quantity: int = Field(ge=1, le=99)
    is_immediate: bool
    option_ids: list[str] = []


class CreateOrderRequest(BaseModel):
    payment_method: str = "cash"
    paid_amount: int = Field(ge=0)
    note: str | None = None
    items: list[OrderItemRequest] = Field(min_length=1)


class CreateMenuItemRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price: int = Field(ge=0)
    default_immediate: bool = True
    sale_stopped: bool = False
    sold_out: bool = False
    is_hidden: bool = False
    remaining_count: int | None = Field(default=None, ge=0)


class UpdateMenuItemRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price: int = Field(ge=0)
    default_immediate: bool = True
    is_active: bool = True
    sale_stopped: bool = False
    sold_out: bool = False
    is_hidden: bool = False
    remaining_count: int | None = Field(default=None, ge=0)


class BulkMenuStatusRequest(BaseModel):
    sale_stopped: bool


class CreateUserRequest(BaseModel):
    login_id: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=200)
    display_name: str = Field(min_length=1, max_length=80)
    permission_codes: list[str] = Field(default_factory=list)


class CreateMenuOptionRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price_delta: int = Field(ge=0)


class UpdateMenuOptionRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price_delta: int = Field(ge=0)
    is_active: bool = True


class UpdateItemStatusRequest(BaseModel):
    status: str


class ReservationRequest(BaseModel):
    slot_id: str
    name: str
    contact_type: str
    contact_value: str
    people_count: int = Field(ge=1, le=20)


app = FastAPI(title="Tenmon Shirokita Festival API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    init_db()


def user_permissions(conn: sqlite3.Connection, user_id: str) -> list[str]:
    rows = conn.execute(
        """
        SELECT p.code
        FROM users u
        JOIN role_permissions rp ON rp.role_id = u.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE u.id = ?
        ORDER BY p.code
        """,
        (user_id,),
    ).fetchall()
    return [row["code"] for row in rows]


def build_user(conn: sqlite3.Connection, user: sqlite3.Row) -> dict[str, Any]:
    role = conn.execute("SELECT name FROM roles WHERE id = ?", (user["role_id"],)).fetchone()
    return {
        "id": user["id"],
        "login_id": user["login_id"],
        "display_name": user["display_name"],
        "role": role["name"] if role else None,
        "permissions": user_permissions(conn, user["id"]),
    }


def current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "認証トークンが必要です")
    token = authorization.split(" ", 1)[1]
    with connect() as conn:
        token_row = conn.execute(
            """
            SELECT * FROM auth_tokens
            WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
            """,
            (hash_token(token), now()),
        ).fetchone()
        if token_row is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "トークンが無効です")
        user = conn.execute(
            "SELECT * FROM users WHERE id = ? AND is_active = 1",
            (token_row["user_id"],),
        ).fetchone()
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "ユーザーが無効です")
        return build_user(conn, user) | {"token_hash": token_row["token_hash"]}


def require_permission(permission: str):
    def dependency(user: Annotated[dict[str, Any], Depends(current_user)]) -> dict[str, Any]:
        if permission not in user["permissions"]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"{permission} 権限が必要です")
        return user

    return dependency


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "time": now()}


@app.post("/auth/login")
def login(payload: LoginRequest, request: Request) -> dict[str, Any]:
    with connect() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE login_id = ? AND is_active = 1",
            (payload.login_id,),
        ).fetchone()
        if user is None or not verify_password(payload.password, user["password_salt"], user["password_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "ログインIDまたはパスワードが違います")

        token = secrets.token_urlsafe(48)
        expires_at = (datetime.now(JST) + timedelta(hours=12)).isoformat(timespec="seconds")
        conn.execute(
            """
            INSERT INTO auth_tokens
              (id, user_id, token_hash, expires_at, revoked_at, ip_address, user_agent, created_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
            """,
            (
                new_id(),
                user["id"],
                hash_token(token),
                expires_at,
                request.client.host if request.client else None,
                request.headers.get("user-agent"),
                now(),
            ),
        )
        conn.execute("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?", (now(), now(), user["id"]))
        log_operation(conn, user_id=user["id"], action="login", request=request)
        conn.commit()
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_at": expires_at,
            "user": build_user(conn, user),
        }


@app.post("/auth/logout")
def logout(
    request: Request,
    user: Annotated[dict[str, Any], Depends(current_user)],
) -> dict[str, bool]:
    with connect() as conn:
        conn.execute("UPDATE auth_tokens SET revoked_at = ? WHERE token_hash = ?", (now(), user["token_hash"]))
        log_operation(conn, user_id=user["id"], action="logout", request=request)
        conn.commit()
        return {"ok": True}


@app.get("/auth/me")
def me(user: Annotated[dict[str, Any], Depends(current_user)]) -> dict[str, Any]:
    return user


@app.get("/access-control")
def access_control(user: Annotated[dict[str, Any], Depends(require_permission("users:read"))]) -> dict[str, Any]:
    with connect() as conn:
        permissions = conn.execute(
            "SELECT code, description FROM permissions ORDER BY code"
        ).fetchall()
        roles = conn.execute("SELECT id, name, description FROM roles ORDER BY name").fetchall()
        return {
            "permissions": [dict(row) for row in permissions],
            "roles": [dict(row) for row in roles],
        }


@app.post("/users")
def create_user(
    payload: CreateUserRequest,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("users:write"))],
) -> dict[str, Any]:
    with connect() as conn:
        existing = conn.execute("SELECT id FROM users WHERE login_id = ?", (payload.login_id,)).fetchone()
        if existing is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "同じログインIDが既に存在します")

        permission_rows = []
        for code in payload.permission_codes:
            permission = conn.execute("SELECT * FROM permissions WHERE code = ?", (code,)).fetchone()
            if permission is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"無効な権限です: {code}")
            permission_rows.append(permission)

        role_id = new_id()
        role_name = f"user:{payload.login_id}"
        conn.execute(
            "INSERT INTO roles VALUES (?, ?, ?, ?, ?)",
            (role_id, role_name, f"{payload.display_name} 専用ロール", now(), now()),
        )
        for permission in permission_rows:
            conn.execute("INSERT INTO role_permissions VALUES (?, ?)", (role_id, permission["id"]))

        salt, password_hash = hash_password(payload.password)
        user_id = new_id()
        conn.execute(
            """
            INSERT INTO users
              (id, role_id, login_id, password_salt, password_hash, display_name, email,
               is_active, last_login_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, 1, NULL, ?, ?)
            """,
            (
                user_id,
                role_id,
                payload.login_id,
                salt,
                password_hash,
                payload.display_name,
                now(),
                now(),
            ),
        )
        log_operation(
            conn,
            user_id=user["id"],
            action="user.create",
            target_type="user",
            target_id=user_id,
            request=request,
            metadata={
                "login_id": payload.login_id,
                "display_name": payload.display_name,
                "permissions": payload.permission_codes,
            },
        )
        conn.commit()
        created = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return build_user(conn, created)


@app.get("/menu-items")
def menu_items(
    user: Annotated[dict[str, Any], Depends(require_permission("orders:read"))],
    include_unavailable: bool = False,
) -> list[dict[str, Any]]:
    with connect() as conn:
        items = []
        if include_unavailable:
            rows = conn.execute(
                "SELECT * FROM menu_items WHERE is_active = 1 ORDER BY sort_order, name"
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM menu_items
                WHERE is_active = 1 AND sale_stopped = 0 AND sold_out = 0 AND is_hidden = 0
                ORDER BY sort_order, name
                """
            ).fetchall()
        for item in rows:
            options = conn.execute(
                "SELECT id, name, price_delta FROM menu_item_options WHERE menu_item_id = ? AND is_active = 1 ORDER BY name",
                (item["id"],),
            ).fetchall()
            items.append(
                {
                    "id": item["id"],
                    "name": item["name"],
                    "price": item["price"],
                    "sale_stopped": bool(item["sale_stopped"]),
                    "sold_out": bool(item["sold_out"]),
                    "is_hidden": bool(item["is_hidden"]),
                    "remaining_count": item["remaining_count"],
                    "default_immediate": bool(item["default_immediate"]),
                    "options": [dict(option) for option in options],
                }
            )
        return items


def next_sequence(conn: sqlite3.Connection, table: str) -> int:
    return conn.execute(f"SELECT COUNT(*) + 1 FROM {table}").fetchone()[0]


def order_number(seq: int, mobile_prefix: str | None = None) -> str:
    if mobile_prefix:
        prefix = mobile_prefix.upper()
        if prefix not in {"A", "B", "C", "D", "E", "F"}:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "mobile_prefix は A-F のいずれかです")
        return f"{prefix}{seq % 100:02d}"
    return f"{seq % 1000:03d}"


def normalize_order_no(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    if text.isdigit():
        return f"{int(text) % 1000:03d}"
    return text


@app.post("/menu-items")
def create_menu_item(
    payload: CreateMenuItemRequest,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("orders:write"))],
) -> dict[str, Any]:
    with connect() as conn:
        item_id = new_id()
        sort_order = next_sequence(conn, "menu_items")
        conn.execute(
            """
            INSERT INTO menu_items
              (id, name, price, is_active, sale_stopped, sold_out, is_hidden,
               remaining_count, default_immediate, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item_id,
                payload.name,
                payload.price,
                int(payload.sale_stopped),
                int(payload.sold_out),
                int(payload.is_hidden),
                payload.remaining_count,
                int(payload.default_immediate),
                sort_order,
                now(),
                now(),
            ),
        )
        log_operation(
            conn,
            user_id=user["id"],
            action="menu_item.create",
            target_type="menu_item",
            target_id=item_id,
            request=request,
            metadata={"name": payload.name, "price": payload.price},
        )
        conn.commit()
        return {
            "id": item_id,
            "name": payload.name,
            "price": payload.price,
            "sale_stopped": payload.sale_stopped,
            "sold_out": payload.sold_out,
            "is_hidden": payload.is_hidden,
            "remaining_count": payload.remaining_count,
            "default_immediate": payload.default_immediate,
            "options": [],
        }


@app.patch("/menu-items/bulk-status")
def update_menu_items_bulk_status(
    payload: BulkMenuStatusRequest,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("orders:write"))],
) -> dict[str, Any]:
    with connect() as conn:
        conn.execute(
            "UPDATE menu_items SET sale_stopped = ?, updated_at = ? WHERE is_active = 1",
            (int(payload.sale_stopped), now()),
        )
        count = conn.execute("SELECT changes()").fetchone()[0]
        log_operation(
            conn,
            user_id=user["id"],
            action="menu_item.bulk_status",
            target_type="menu_item",
            target_id=None,
            request=request,
            metadata={"sale_stopped": payload.sale_stopped, "count": count},
        )
        conn.commit()
        return {"ok": True, "count": count, "sale_stopped": payload.sale_stopped}


@app.patch("/menu-items/{item_id}")
def update_menu_item(
    item_id: str,
    payload: UpdateMenuItemRequest,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("orders:write"))],
) -> dict[str, Any]:
    with connect() as conn:
        item = conn.execute("SELECT * FROM menu_items WHERE id = ?", (item_id,)).fetchone()
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "商品が見つかりません")
        conn.execute(
            """
            UPDATE menu_items
            SET name = ?, price = ?, default_immediate = ?, is_active = ?,
                sale_stopped = ?, sold_out = ?, is_hidden = ?, remaining_count = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (
                payload.name,
                payload.price,
                int(payload.default_immediate),
                int(payload.is_active),
                int(payload.sale_stopped),
                int(payload.sold_out),
                int(payload.is_hidden),
                payload.remaining_count,
                now(),
                item_id,
            ),
        )
        log_operation(
            conn,
            user_id=user["id"],
            action="menu_item.update",
            target_type="menu_item",
            target_id=item_id,
            request=request,
            metadata=payload.model_dump(),
        )
        conn.commit()
        return {"ok": True}


@app.delete("/menu-items/{item_id}")
def delete_menu_item(
    item_id: str,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("orders:write"))],
) -> dict[str, bool]:
    with connect() as conn:
        item = conn.execute("SELECT * FROM menu_items WHERE id = ?", (item_id,)).fetchone()
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "商品が見つかりません")
        conn.execute("UPDATE menu_items SET is_active = 0, updated_at = ? WHERE id = ?", (now(), item_id))
        log_operation(
            conn,
            user_id=user["id"],
            action="menu_item.delete",
            target_type="menu_item",
            target_id=item_id,
            request=request,
            metadata={"name": item["name"]},
        )
        conn.commit()
        return {"ok": True}


@app.post("/menu-items/{item_id}/options")
def create_menu_option(
    item_id: str,
    payload: CreateMenuOptionRequest,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("orders:write"))],
) -> dict[str, Any]:
    with connect() as conn:
        item = conn.execute("SELECT * FROM menu_items WHERE id = ? AND is_active = 1", (item_id,)).fetchone()
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "商品が見つかりません")
        option_id = new_id()
        conn.execute(
            "INSERT INTO menu_item_options VALUES (?, ?, ?, ?, 1, ?)",
            (option_id, item_id, payload.name, payload.price_delta, now()),
        )
        log_operation(
            conn,
            user_id=user["id"],
            action="menu_option.create",
            target_type="menu_option",
            target_id=option_id,
            request=request,
            metadata={"item_id": item_id, "name": payload.name, "price_delta": payload.price_delta},
        )
        conn.commit()
        return {"id": option_id, "name": payload.name, "price_delta": payload.price_delta}


@app.patch("/menu-items/{item_id}/options/{option_id}")
def update_menu_option(
    item_id: str,
    option_id: str,
    payload: UpdateMenuOptionRequest,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("orders:write"))],
) -> dict[str, bool]:
    with connect() as conn:
        option = conn.execute(
            "SELECT * FROM menu_item_options WHERE id = ? AND menu_item_id = ?",
            (option_id, item_id),
        ).fetchone()
        if option is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "オプションが見つかりません")
        conn.execute(
            "UPDATE menu_item_options SET name = ?, price_delta = ?, is_active = ? WHERE id = ?",
            (payload.name, payload.price_delta, int(payload.is_active), option_id),
        )
        log_operation(
            conn,
            user_id=user["id"],
            action="menu_option.update",
            target_type="menu_option",
            target_id=option_id,
            request=request,
            metadata=payload.model_dump(),
        )
        conn.commit()
        return {"ok": True}


@app.delete("/menu-items/{item_id}/options/{option_id}")
def delete_menu_option(
    item_id: str,
    option_id: str,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("orders:write"))],
) -> dict[str, bool]:
    with connect() as conn:
        option = conn.execute(
            "SELECT * FROM menu_item_options WHERE id = ? AND menu_item_id = ?",
            (option_id, item_id),
        ).fetchone()
        if option is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "オプションが見つかりません")
        conn.execute("UPDATE menu_item_options SET is_active = 0 WHERE id = ?", (option_id,))
        log_operation(
            conn,
            user_id=user["id"],
            action="menu_option.delete",
            target_type="menu_option",
            target_id=option_id,
            request=request,
            metadata={"item_id": item_id, "name": option["name"]},
        )
        conn.commit()
        return {"ok": True}


@app.post("/stall/orders")
def create_order(
    payload: CreateOrderRequest,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("orders:write"))],
) -> dict[str, Any]:
    with connect() as conn:
        total = 0
        prepared_items = []
        requested_counts: dict[str, int] = {}
        has_waiting = False
        for requested in payload.items:
            item = conn.execute(
                """
                SELECT * FROM menu_items
                WHERE id = ? AND is_active = 1 AND sale_stopped = 0
                  AND sold_out = 0 AND is_hidden = 0
                """,
                (requested.menu_item_id,),
            ).fetchone()
            if item is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "無効な商品です")
            if item["remaining_count"] is not None and item["remaining_count"] < requested.quantity:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{item['name']} の残数が不足しています")
            requested_counts[item["id"]] = requested_counts.get(item["id"], 0) + requested.quantity
            option_rows = []
            option_total = 0
            for option_id in requested.option_ids:
                option = conn.execute(
                    """
                    SELECT * FROM menu_item_options
                    WHERE id = ? AND menu_item_id = ? AND is_active = 1
                    """,
                    (option_id, requested.menu_item_id),
                ).fetchone()
                if option is None:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, "無効なオプションです")
                option_rows.append(option)
                option_total += option["price_delta"]
            unit_price = item["price"] + option_total
            line_total = unit_price * requested.quantity
            total += line_total
            has_waiting = has_waiting or not requested.is_immediate
            prepared_items.append((requested, item, option_rows, unit_price, line_total))

        for item_id, quantity in requested_counts.items():
            latest = conn.execute("SELECT * FROM menu_items WHERE id = ?", (item_id,)).fetchone()
            if latest["remaining_count"] is None:
                continue
            next_count = max(0, latest["remaining_count"] - quantity)
            conn.execute(
                """
                UPDATE menu_items
                SET remaining_count = ?, sold_out = CASE WHEN ? <= 0 THEN 1 ELSE sold_out END,
                    updated_at = ?
                WHERE id = ?
                """,
                (next_count, next_count, now(), item_id),
            )

        order_seq = next_sequence(conn, "stall_orders")
        order_id = new_id()
        order_no = order_number(order_seq)
        call_no = order_no if has_waiting else None
        order_status = "ready" if has_waiting else "served"
        served_at = now() if order_status == "served" else None
        conn.execute(
            """
            INSERT INTO stall_orders
              (id, order_no, call_no, created_by_user_id, status, total_amount, paid_amount,
               payment_method, note, created_at, updated_at, served_at, cancelled_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                order_id,
                order_no,
                call_no,
                user["id"],
                order_status,
                total,
                payload.paid_amount,
                payload.payment_method,
                payload.note,
                now(),
                now(),
                served_at,
            ),
        )

        response_items = []
        for requested, item, option_rows, unit_price, line_total in prepared_items:
            item_id = new_id()
            item_status = "served" if requested.is_immediate else "ready"
            provided_at = now() if requested.is_immediate else None
            conn.execute(
                """
                INSERT INTO stall_order_items
                  (id, order_id, menu_item_id, item_name, unit_price, quantity, line_total,
                   is_immediate, status, provided_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    order_id,
                    item["id"],
                    item["name"],
                    unit_price,
                    requested.quantity,
                    line_total,
                    int(requested.is_immediate),
                    item_status,
                    provided_at,
                ),
            )
            for option in option_rows:
                conn.execute(
                    "INSERT INTO stall_order_item_options VALUES (?, ?, ?, ?, ?)",
                    (new_id(), item_id, option["id"], option["name"], option["price_delta"]),
                )
            response_items.append(
                {
                    "id": item_id,
                    "name": item["name"],
                    "quantity": requested.quantity,
                    "is_immediate": requested.is_immediate,
                    "status": item_status,
                    "line_total": line_total,
                }
            )

        log_operation(
            conn,
            user_id=user["id"],
            action="order.create",
            target_type="order",
            target_id=order_id,
            request=request,
            metadata={"order_no": order_no, "total_amount": total},
        )
        conn.commit()
        return {
            "id": order_id,
            "order_no": order_no,
            "call_no": call_no,
            "status": order_status,
            "total_amount": total,
            "paid_amount": payload.paid_amount,
            "change_amount": payload.paid_amount - total,
            "items": response_items,
        }


def order_response(conn: sqlite3.Connection, order: sqlite3.Row) -> dict[str, Any]:
    items = conn.execute("SELECT * FROM stall_order_items WHERE order_id = ? ORDER BY rowid", (order["id"],)).fetchall()
    creator = conn.execute("SELECT display_name, login_id FROM users WHERE id = ?", (order["created_by_user_id"],)).fetchone()
    data = dict(order)
    data["order_no"] = normalize_order_no(data.get("order_no")) or data.get("order_no")
    data["call_no"] = normalize_order_no(data.get("call_no"))
    data["created_by_display_name"] = creator["display_name"] if creator else "不明"
    data["created_by_login_id"] = creator["login_id"] if creator else None
    return data | {
        "items": [dict(item) | {"is_immediate": bool(item["is_immediate"])} for item in items],
    }


@app.get("/stall/orders")
def list_orders(
    user: Annotated[dict[str, Any], Depends(require_permission("orders:read"))],
    status: str | None = None,
) -> list[dict[str, Any]]:
    with connect() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM stall_orders WHERE status = ? ORDER BY created_at DESC",
                (status,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM stall_orders ORDER BY created_at DESC LIMIT 100").fetchall()
        return [order_response(conn, row) for row in rows]


@app.get("/sales/summary")
def sales_summary(user: Annotated[dict[str, Any], Depends(require_permission("orders:read"))]) -> dict[str, Any]:
    with connect() as conn:
        stall_rows = conn.execute(
            """
            SELECT o.*, u.display_name, u.login_id
            FROM stall_orders o
            LEFT JOIN users u ON u.id = o.created_by_user_id
            WHERE o.status != 'cancelled'
            ORDER BY o.created_at DESC
            """
        ).fetchall()
        planetarium_rows = conn.execute(
            """
            SELECT r.*, u.display_name, u.login_id
            FROM planetarium_reservations r
            LEFT JOIN users u ON u.id = r.created_by_user_id
            WHERE r.status != 'cancelled'
            ORDER BY r.created_at DESC
            """
        ).fetchall()

        stall_total = sum(row["total_amount"] for row in stall_rows)
        planetarium_total = sum(row["revenue_amount"] for row in planetarium_rows)
        member_totals: dict[str, dict[str, Any]] = {}

        def add_member(row: sqlite3.Row, amount: int, department: str) -> None:
            user_id = row["created_by_user_id"] if "created_by_user_id" in row.keys() else None
            key = user_id or "unknown"
            if key not in member_totals:
                member_totals[key] = {
                    "user_id": user_id,
                    "display_name": row["display_name"] or "不明",
                    "login_id": row["login_id"],
                    "stall_total": 0,
                    "planetarium_total": 0,
                    "total": 0,
                }
            member_totals[key][f"{department}_total"] += amount
            member_totals[key]["total"] += amount

        logs = []
        for row in stall_rows:
            amount = row["total_amount"]
            add_member(row, amount, "stall")
            order_no = normalize_order_no(row["order_no"]) or row["order_no"]
            display_name = row["display_name"] or "不明"
            logs.append(
                {
                    "id": row["id"],
                    "department": "stall",
                    "department_label": "屋台",
                    "user_id": row["created_by_user_id"],
                    "login_id": row["login_id"],
                    "document_no": order_no,
                    "status": row["status"],
                    "amount": amount,
                    "display_name": display_name,
                    "created_at": row["created_at"],
                    "message": f"{display_name}が、屋台で{amount}円の売り上げを計上しました。",
                }
            )

        for row in planetarium_rows:
            amount = row["revenue_amount"]
            add_member(row, amount, "planetarium")
            display_name = row["display_name"] or "不明"
            logs.append(
                {
                    "id": row["id"],
                    "department": "planetarium",
                    "department_label": "プラネタリウム",
                    "user_id": row["created_by_user_id"],
                    "login_id": row["login_id"],
                    "document_no": row["reservation_no"],
                    "status": row["status"],
                    "amount": amount,
                    "display_name": display_name,
                    "created_at": row["created_at"],
                    "message": f"{display_name}が、プラネタリウムで{amount}円の売り上げを計上しました。",
                }
            )

        logs.sort(key=lambda item: item["created_at"], reverse=True)
        return {
            "categories": {
                "stall": stall_total,
                "planetarium": planetarium_total,
                "total": stall_total + planetarium_total,
            },
            "members": sorted(member_totals.values(), key=lambda item: item["total"], reverse=True),
            "logs": logs,
        }


@app.patch("/stall/orders/{order_id}/items/{item_id}/status")
def update_order_item_status(
    order_id: str,
    item_id: str,
    payload: UpdateItemStatusRequest,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("orders:serve"))],
) -> dict[str, Any]:
    if payload.status not in {"pending", "preparing", "ready", "called", "served", "cancelled"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "無効なステータスです")
    with connect() as conn:
        item = conn.execute(
            "SELECT * FROM stall_order_items WHERE id = ? AND order_id = ?",
            (item_id, order_id),
        ).fetchone()
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "注文明細が見つかりません")
        provided_at = now() if payload.status == "served" else item["provided_at"]
        conn.execute(
            "UPDATE stall_order_items SET status = ?, provided_at = ? WHERE id = ?",
            (payload.status, provided_at, item_id),
        )
        active_items = conn.execute(
            "SELECT status FROM stall_order_items WHERE order_id = ? AND status != 'cancelled'",
            (order_id,),
        ).fetchall()
        if active_items and all(row["status"] == "served" for row in active_items):
            conn.execute(
                "UPDATE stall_orders SET status = 'served', served_at = ?, updated_at = ? WHERE id = ?",
                (now(), now(), order_id),
            )
        elif active_items and all(row["status"] in {"called", "served"} for row in active_items):
            conn.execute("UPDATE stall_orders SET status = 'called', updated_at = ? WHERE id = ?", (now(), order_id))
        else:
            conn.execute("UPDATE stall_orders SET status = 'ready', updated_at = ? WHERE id = ?", (now(), order_id))
        log_operation(
            conn,
            user_id=user["id"],
            action="order_item.status",
            target_type="order_item",
            target_id=item_id,
            request=request,
            metadata={"status": payload.status},
        )
        conn.commit()
        order = conn.execute("SELECT * FROM stall_orders WHERE id = ?", (order_id,)).fetchone()
        return order_response(conn, order)


@app.get("/planetarium/slots")
def list_slots(user: Annotated[dict[str, Any], Depends(require_permission("reservations:read"))]) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM planetarium_slots ORDER BY starts_at").fetchall()
        return [dict(row) | {"is_active": bool(row["is_active"])} for row in rows]


@app.post("/planetarium/reservations")
def create_reservation(
    payload: ReservationRequest,
    request: Request,
    user: Annotated[dict[str, Any], Depends(require_permission("reservations:write"))],
) -> dict[str, Any]:
    if payload.contact_type not in {"email", "line", "apple"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "contact_type は email, line, apple のいずれかです")
    with connect() as conn:
        slot = conn.execute("SELECT * FROM planetarium_slots WHERE id = ? AND is_active = 1", (payload.slot_id,)).fetchone()
        if slot is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "予約枠が見つかりません")
        if slot["reserved_count"] + payload.people_count > slot["capacity"]:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "残席が不足しています")
        reservation_id = new_id()
        reservation_no = f"P-{datetime.now(JST).strftime('%Y%m%d')}-{next_sequence(conn, 'planetarium_reservations'):04d}"
        revenue_amount = payload.people_count * PLANETARIUM_UNIT_PRICE
        try:
            conn.execute(
                """
                INSERT INTO planetarium_reservations
                  (id, slot_id, reservation_no, name, contact_type, contact_value, people_count,
                   created_by_user_id, revenue_amount, status, created_at, updated_at, checked_in_at, cancelled_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, NULL, NULL)
                """,
                (
                    reservation_id,
                    payload.slot_id,
                    reservation_no,
                    payload.name,
                    payload.contact_type,
                    payload.contact_value,
                    payload.people_count,
                    user["id"],
                    revenue_amount,
                    now(),
                    now(),
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, "同じ連絡先で既に予約されています") from exc
        conn.execute(
            "UPDATE planetarium_slots SET reserved_count = reserved_count + ?, updated_at = ? WHERE id = ?",
            (payload.people_count, now(), payload.slot_id),
        )
        log_operation(
            conn,
            user_id=user["id"],
            action="reservation.create",
            target_type="reservation",
            target_id=reservation_id,
            request=request,
            metadata={"reservation_no": reservation_no, "people_count": payload.people_count},
        )
        conn.commit()
        return {
            "id": reservation_id,
            "reservation_no": reservation_no,
            "status": "reserved",
        }


@app.get("/operation-logs")
def operation_logs(user: Annotated[dict[str, Any], Depends(require_permission("logs:read"))]) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT l.*, u.display_name
            FROM user_operation_logs l
            LEFT JOIN users u ON u.id = l.user_id
            ORDER BY l.created_at DESC
            LIMIT 100
            """
        ).fetchall()
        return [
            dict(row) | {"metadata": json.loads(row["metadata"] or "{}")}
            for row in rows
        ]
