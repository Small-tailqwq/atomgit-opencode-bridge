#!/usr/bin/env bash
# 测试 Coding Plan API 是否接受 OpenAI 格式的 reasoning_effort 参数
# 前置条件: proxy.js 已在本地 9457 端口运行

set -euo pipefail

PROXY_URL="${1:-http://127.0.0.1:9457}"

echo "=== 1. 测试默认请求（无 reasoning_effort） ==="
curl -s "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "say hi"}],
    "stream": false,
    "max_tokens": 50
  }' | python3 -c "
import sys, json
resp = json.load(sys.stdin)
choice = resp['choices'][0]
msg = choice['message']
print(f'Status: finish_reason={choice[\"finish_reason\"]}')
print(f'Content: {msg.get(\"content\", \"\")[:120]}')
print(f'Has reasoning_content: {\"reasoning_content\" in msg}')
print()

# 清理 usage 让输出更短
usage = resp.get('usage', {})
print(f'Usage: {usage.get(\"prompt_tokens\",\"?\")}in / {usage.get(\"completion_tokens\",\"?\")}out')
"
echo

echo "=== 2. 测试带 reasoning_effort 参数 ==="
curl -s "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "is 11 a prime number? explain"}],
    "stream": false,
    "max_tokens": 200,
    "reasoning_effort": "high"
  }' | python3 -c "
import sys, json
resp = json.load(sys.stdin)
choice = resp['choices'][0]
msg = choice['message']
print(f'Status: finish_reason={choice[\"finish_reason\"]}')
print(f'Content: {msg.get(\"content\", \"\")[:200]}')
print(f'Has reasoning_content: {\"reasoning_content\" in msg}')
if 'reasoning_content' in msg:
    rc = msg['reasoning_content']
    print(f'Reasoning length: {len(rc)} chars')
    print(f'Reasoning preview: {rc[:150]}')
print()
usage = resp.get('usage', {})
print(f'Usage: {usage.get(\"prompt_tokens\",\"?\")}in / {usage.get(\"completion_tokens\",\"?\")}out')
"
echo

echo "=== 3. 检查返回体中是否回显了 reasoning_effort ==="
curl -s "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "say hi"}],
    "stream": false,
    "max_tokens": 50,
    "reasoning_effort": "high"
  }' | python3 -c "
import sys, json
resp = json.load(sys.stdin)
print(f'Top-level keys: {list(resp.keys())}')
# 检查除标准字段外是否有额外的回显
for k in resp:
    if k not in ('id','object','created','model','choices','usage','system_fingerprint'):
        print(f'  Extra key: {k}={str(resp[k])[:80]}')
"
echo

echo "=== 测试完成 ==="
echo "如果测试2中 reasoning_content 存在且内容合理，说明 API 接受了 reasoning_effort 参数并产生了思考过程。"
echo "如果测试1和2的 response 结构一致，说明 API 忽略了 reasoning_effort（无视了参数）。"
echo "如果测试2报错/400，说明 API 拒绝 reasoning_effort（可能没实现）。"
