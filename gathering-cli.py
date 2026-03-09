#!/usr/bin/env python3
"""Minimal CLI chat client for Gathering servers."""

import argparse
import asyncio
import json
import os
import ssl
import sys
from datetime import datetime, timezone
from getpass import getpass
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

try:
    import websockets
except ImportError:
    print("Missing dependency: pip install websockets", file=sys.stderr)
    sys.exit(1)


def make_ssl_ctx(verify: bool) -> ssl.SSLContext:
    if verify:
        return ssl.create_default_context()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def login(server: str, username: str, password: str, ssl_ctx: ssl.SSLContext) -> str:
    url = f"{server}/api/login"
    data = json.dumps({"username": username, "password": password}).encode()
    req = Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        resp = urlopen(req, context=ssl_ctx)
    except HTTPError as e:
        body = json.loads(e.read())
        print(f"Login failed: {body.get('error', e)}", file=sys.stderr)
        sys.exit(1)
    except URLError as e:
        print(f"Connection failed: {e.reason}", file=sys.stderr)
        sys.exit(1)
    body = json.loads(resp.read())
    if not body.get("ok"):
        print(f"Login failed: {body.get('error')}", file=sys.stderr)
        sys.exit(1)
    return body["token"]


def fmt_time(ts: str) -> str:
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%H:%M")
    except Exception:
        return "??:??"


def print_msg(author: str, content: str, timestamp: str):
    print(f"[{fmt_time(timestamp)}] <{author}> {content}", flush=True)


def emit_json(**kwargs):
    """Print a JSON line to stdout (bot mode)."""
    print(json.dumps(kwargs), flush=True)


async def ws_connect_and_auth(args, ssl_ctx):
    """Connect to WebSocket and authenticate. Returns (ws, channel)."""
    if args.token:
        token = args.token
    else:
        password = args.password or os.environ.get("GATHERING_PASSWORD") or getpass("Password: ")
        token = login(args.server, args.username, password, ssl_ctx)
        print(f"Logged in as {args.username}", file=sys.stderr)

    parsed = urlparse(args.server)
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    ws_host = parsed.hostname
    ws_port = parsed.port or (443 if ws_scheme == "wss" else 80)
    ws_url = f"{ws_scheme}://{ws_host}:{ws_port}/ws"

    ws = await websockets.connect(ws_url, ssl=ssl_ctx if ws_scheme == "wss" else None)

    # Authenticate (server may send other messages before AuthResult)
    await ws.send(json.dumps({"type": "Auth", "token": token}))
    authed = False
    for _ in range(20):
        resp = json.loads(await ws.recv())
        if resp.get("type") == "AuthResult":
            if not resp.get("ok"):
                print(f"Auth failed: {resp.get('error', 'unknown')}", file=sys.stderr)
                sys.exit(1)
            authed = True
            break
    if not authed:
        print("Auth failed: no AuthResult received", file=sys.stderr)
        sys.exit(1)

    channel = args.channel
    await ws.send(json.dumps({"type": "Join", "channel": channel}))
    await ws.send(json.dumps({"type": "History", "channel": channel, "limit": 50}))
    return ws, channel


async def run_interactive(args):
    ssl_ctx = make_ssl_ctx(not args.insecure)
    ws, channel = await ws_connect_and_auth(args, ssl_ctx)

    print(f"Connected. Type messages or /join <channel> or /quit", file=sys.stderr)
    print(f"--- #{channel} ---", file=sys.stderr)

    async def reader():
        nonlocal channel
        async for raw in ws:
            msg = json.loads(raw)
            t = msg.get("type")
            if t == "Message" and msg.get("channel") == channel:
                print_msg(msg["author"], msg["content"], msg["timestamp"])
            elif t == "History" and msg.get("channel") == channel:
                for m in msg.get("messages", []):
                    print_msg(m["author"], m["content"], m["timestamp"])
            elif t == "UserJoined" and msg.get("channel") == channel:
                print(f"* {msg['username']} joined", file=sys.stderr)
            elif t == "UserLeft" and msg.get("channel") == channel:
                print(f"* {msg['username']} left", file=sys.stderr)
            elif t == "Error":
                print(f"! {msg['message']}", file=sys.stderr)
            elif t == "System":
                print(f"* {msg['content']}", file=sys.stderr)

    async def writer():
        nonlocal channel
        loop = asyncio.get_event_loop()
        while True:
            try:
                line = await loop.run_in_executor(None, sys.stdin.readline)
            except EOFError:
                break
            if not line:  # EOF
                break
            line = line.rstrip("\n")
            if not line:
                continue
            if line == "/quit":
                break
            if line.startswith("/join "):
                new_ch = line[6:].strip()
                if new_ch:
                    await ws.send(json.dumps({"type": "Leave", "channel": channel}))
                    channel = new_ch
                    await ws.send(json.dumps({"type": "Join", "channel": channel}))
                    await ws.send(json.dumps({"type": "History", "channel": channel, "limit": 50}))
                    print(f"--- #{channel} ---", file=sys.stderr)
                continue
            await ws.send(json.dumps({
                "type": "Send", "channel": channel,
                "content": line, "encrypted": False,
            }))

    reader_task = asyncio.create_task(reader())
    writer_task = asyncio.create_task(writer())
    done, pending = await asyncio.wait(
        [reader_task, writer_task], return_when=asyncio.FIRST_COMPLETED
    )
    for t in pending:
        t.cancel()
    await ws.close()


async def run_bot(args):
    """Bot mode: JSON lines on stdout, plain text lines on stdin to send."""
    ssl_ctx = make_ssl_ctx(not args.insecure)
    ws, channel = await ws_connect_and_auth(args, ssl_ctx)

    emit_json(event="connected", channel=channel)
    print(f"Bot connected to #{channel}", file=sys.stderr)

    async def reader():
        nonlocal channel
        async for raw in ws:
            msg = json.loads(raw)
            t = msg.get("type")
            if t == "Message":
                emit_json(
                    event="message",
                    channel=msg.get("channel", ""),
                    author=msg.get("author", ""),
                    content=msg.get("content", ""),
                    timestamp=msg.get("timestamp", ""),
                    id=msg.get("id", ""),
                )
            elif t == "History":
                for m in msg.get("messages", []):
                    emit_json(
                        event="history",
                        channel=msg.get("channel", ""),
                        author=m.get("author", ""),
                        content=m.get("content", ""),
                        timestamp=m.get("timestamp", ""),
                        id=m.get("id", ""),
                    )
            elif t == "UserJoined":
                emit_json(event="user_joined", channel=msg.get("channel", ""), username=msg.get("username", ""))
            elif t == "UserLeft":
                emit_json(event="user_left", channel=msg.get("channel", ""), username=msg.get("username", ""))
            elif t == "Error":
                emit_json(event="error", message=msg.get("message", ""))
            elif t == "System":
                emit_json(event="system", content=msg.get("content", ""))

    async def writer():
        nonlocal channel
        loop = asyncio.get_event_loop()
        while True:
            try:
                line = await loop.run_in_executor(None, sys.stdin.readline)
            except EOFError:
                break
            if not line:  # EOF
                break
            line = line.rstrip("\n")
            if not line:
                continue
            # Check for JSON command input
            if line.startswith("{"):
                try:
                    cmd = json.loads(line)
                    if cmd.get("action") == "join":
                        await ws.send(json.dumps({"type": "Leave", "channel": channel}))
                        channel = cmd["channel"]
                        await ws.send(json.dumps({"type": "Join", "channel": channel}))
                        await ws.send(json.dumps({"type": "History", "channel": channel, "limit": 50}))
                        emit_json(event="joined", channel=channel)
                        continue
                    elif cmd.get("action") == "send":
                        ch = cmd.get("channel", channel)
                        await ws.send(json.dumps({
                            "type": "Send", "channel": ch,
                            "content": cmd["content"], "encrypted": False,
                        }))
                        continue
                except (json.JSONDecodeError, KeyError):
                    pass
            # Plain text: send to current channel
            await ws.send(json.dumps({
                "type": "Send", "channel": channel,
                "content": line, "encrypted": False,
            }))

    reader_task = asyncio.create_task(reader())
    writer_task = asyncio.create_task(writer())
    done, pending = await asyncio.wait(
        [reader_task, writer_task], return_when=asyncio.FIRST_COMPLETED
    )
    for t in pending:
        t.cancel()
    await ws.close()


def main():
    p = argparse.ArgumentParser(description="Gathering CLI chat client")
    p.add_argument("server", help="Server URL (e.g. https://192.168.1.5:9123)")
    p.add_argument("username", help="Username to login with")
    p.add_argument("password", nargs="?", help="Password (omit to prompt, or set GATHERING_PASSWORD)")
    p.add_argument("-k", "--insecure", action="store_true", help="Skip TLS verification")
    p.add_argument("-c", "--channel", default="general", help="Channel to join (default: general)")
    p.add_argument("-t", "--token", help="Use existing auth token (skip login)")
    p.add_argument("--bot", action="store_true", help="Bot mode: JSON lines out, text or JSON commands in")
    args = p.parse_args()
    try:
        if args.bot:
            asyncio.run(run_bot(args))
        else:
            asyncio.run(run_interactive(args))
    except KeyboardInterrupt:
        print("\nDisconnected.", file=sys.stderr)


if __name__ == "__main__":
    main()
