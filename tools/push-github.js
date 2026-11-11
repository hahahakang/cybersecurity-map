#!/usr/bin/env node
/**
 * push-github.js —— 通过 GitHub Contents API 提交静态站文件到 main 分支
 *
 * 安全约束：
 *   - Token 只从环境变量 GITHUB_TOKEN 读取（或 GH_TOKEN_FILE 指定的仓库外文件，默认 ~/.config/cyber-map-github-token）；
 *   - Token 绝不硬编码、不写进仓库、不打印到日志；
 *   - 推送前先用 /user 验证 token，401 立即失败并提示更换，不做任何写操作。
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx node tools/push-github.js "commit message"
 *   node tools/push-github.js "commit message"   # 走 token 文件
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const OWNER = 'hahahakang';
const REPO = 'cybersecurity-map';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');
const FILES = [
  'index.html',
  'data/quotes.latest.json',
  'tools/apply-quotes.js',
  'tools/push-github.js',
  'tools/README.md'
];

function token() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) return process.env.GITHUB_TOKEN.trim();
  const f = process.env.GH_TOKEN_FILE || path.join(os.homedir(), '.config', 'cyber-map-github-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  console.error('✗ 未找到 GitHub Token：请设置环境变量 GITHUB_TOKEN，或写入仓库外文件 ' + f);
  process.exit(2);
}
const TOKEN = token();
const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/';
const HEADERS = {
  'Authorization': 'Bearer ' + TOKEN,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'cyber-map-refresh'
};

async function api(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-json */ }
  return { status: res.status, body };
}

(async function main() {
  const message = process.argv[2] || ('chore(quotes): 每日行情刷新 ' + new Date().toISOString().slice(0, 10));

  // 1) 验证 token，避免写入中途 401
  const who = await api('https://api.github.com/user', { headers: HEADERS });
  if (who.status === 401) {
    console.error('✗ GitHub Token 已失效（401 Unauthorized）。请在 GitHub → Settings → Developer settings → Personal access tokens (classic) 重新签发（勾选 repo 权限，建议无过期），更新 GITHUB_TOKEN 后重试。本次未做任何写入。');
    process.exit(3);
  }
  if (who.status !== 200) {
    console.error('✗ Token 校验返回异常 HTTP ' + who.status + '：' + JSON.stringify((who.body || {}).message || ''));
    process.exit(3);
  }
  console.log('✓ Token 有效（账号 ' + who.body.login + '），开始推送 ' + FILES.length + ' 个文件');

  let ok = 0;
  for (const rel of FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.error('✗ 本地缺文件，中止：' + rel); process.exit(4); }
    const content = fs.readFileSync(abs).toString('base64');
    const get = await api(API + encodeURIComponent(rel) + '?ref=' + BRANCH, { headers: HEADERS });
    const sha = (get.status === 200 && get.body && get.body.sha) ? get.body.sha : null;
    const payload = { message, content, branch: BRANCH };
    if (sha) payload.sha = sha;
    const put = await api(API + encodeURIComponent(rel), {
      method: 'PUT',
      headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    if (put.status === 200 || put.status === 201) {
      console.log('  ✓ ' + rel + (sha ? '（更新 sha=' + put.body.content.sha.slice(0, 7) + '）' : '（新建）'));
      ok++;
    } else {
      console.error('  ✗ ' + rel + ' 推送失败 HTTP ' + put.status + '：' + JSON.stringify((put.body || {}).message || put.body));
      process.exit(5);
    }
  }
  console.log('✓ 全部完成：' + ok + '/' + FILES.length + ' 个文件已提交到 ' + BRANCH + '。GitHub Pages 通常 1–2 分钟后生效。');
})().catch(e => { console.error('✗ 推送异常：' + e.message); process.exit(1); });
