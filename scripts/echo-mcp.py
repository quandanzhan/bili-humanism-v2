#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""最小 MCP server（stdio，JSON-RPC 2.0）—— 仅用于验证内核的 MCP 客户端是否正常。
手写协议不依赖 mcp 库，几十行就能跑，正好检验握手/工具列表/调用三件事。
"""
import json
import sys

TOOLS = [{
    "name": "echo",
    "description": "回显传入的文本（测试用）",
    "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}
}]


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        m = msg.get("method")
        mid = msg.get("id")
        if m == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "echo-mcp", "version": "1.0.0"}}})
        elif m == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        elif m == "tools/call":
            args = (msg.get("params") or {}).get("arguments") or {}
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": "echo: " + str(args.get("text", ""))}],
                "isError": False}})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": {}})


if __name__ == "__main__":
    main()
