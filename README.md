# Markdown Lab

基于 Node.js + Express + Socket.IO 的 Markdown 在线预览与协作网页服务器。

## 功能概览

- 单人模式：仅在当前浏览器页面内存中编辑与预览
- 合作模式：通过房间共享同一份 Markdown 文本
- Markdown 解析：`marked.js`（浏览器端）
- 代码高亮：`highlight.js`（浏览器端）
- 用户系统：基于 Cookie 的虚拟账号
- 管理员面板：查看活跃房间、设置房间人数上限、设置违禁词
- 房间限制：每个账户最多创建 3 个房间，每个房间最多 `maxPerson` 人在线
- 在线成员列表：所有成员可见
- 服务器负载角标：显示连接数、房间数、内存、运行时长、系统负载

---

## 项目结构

```text
.
├─ server.js
├─ package.json
└─ public/
   └─ index.html
```

---

## 本地运行

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

默认监听：

```text
http://localhost:3000
```

---

## 环境变量

当前项目支持以下环境变量：

| 变量名 | 默认值 | 说明 |
|---|---:|---|
| `PORT` | `3000` | 服务监听端口 |
| `ADMIN_COOKIE_CODE` | `1145` | 管理员 Cookie 暗号 |
| `DEFAULT_MAX_PERSON` | `5` | 默认房间最大在线人数 |

示例：

```bash
PORT=3000 ADMIN_COOKIE_CODE=9527 DEFAULT_MAX_PERSON=8 npm start
```

在 Windows PowerShell 中：

```powershell
$env:PORT=3000
$env:ADMIN_COOKIE_CODE=9527
$env:DEFAULT_MAX_PERSON=8
npm start
```

---

## 数据库配置说明

本项目 **当前不使用数据库**。

所有数据均保存在 Node.js 进程内存中，包括：

- 房间列表
- 房间内容
- 房主信息
- 在线成员
- 管理员设置（当前进程生命周期内有效）

这意味着：

- **重启服务后数据会丢失**
- **不需要配置 MySQL / PostgreSQL / Redis / MongoDB**
- 若后续需要持久化，可再扩展数据库层

所以对于“数据库配置”这一项，当前版本的正确配置结论是：

```text
无需数据库配置
```

---

## WebSocket / Socket.IO 配置说明

本项目使用 `Socket.IO` 做房间内实时同步。

### 当前行为

- 客户端连接 `/socket.io/`
- 用户加入房间后，服务器执行 `socket.join(roomId)`
- 用户编辑文本时，客户端发送 `sync-content`
- 服务端接收后更新房间内存内容
- 然后通过：

```js
socket.to(roomId).emit('remote-content', ...)
```

广播给同房间的其他成员，不回发给发送者

### 反向代理时的关键点

如果你把 Node.js 放在 Nginx 后面，必须确保：

- 开启 HTTP/1.1
- 透传 `Upgrade` 和 `Connection` 头
- 允许 `/socket.io/` 正常反向代理

否则 WebSocket 升级会失败，协作功能无法正常工作。

---

## Debian 服务器部署方法

以下示例基于 Debian 12。

### 1. 安装 Node.js 与 Nginx

```bash
sudo apt update
sudo apt install -y curl nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 2. 上传项目

假设部署目录为：

```text
/var/www/markdown-lab
```

将项目上传到服务器后执行：

```bash
cd /var/www/markdown-lab
npm install
```

### 3. 启动前测试

```bash
PORT=3000 ADMIN_COOKIE_CODE=1145 DEFAULT_MAX_PERSON=5 npm start
```

确认日志输出正常后，按 `Ctrl + C` 停止，继续配置 systemd。

### 4. 配置 systemd 服务

创建：

```text
/etc/systemd/system/markdown-lab.service
```

内容如下：

```ini
[Unit]
Description=Markdown Lab Node.js Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/markdown-lab
ExecStart=/usr/bin/node /var/www/markdown-lab/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=ADMIN_COOKIE_CODE=1145
Environment=DEFAULT_MAX_PERSON=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable markdown-lab
sudo systemctl start markdown-lab
sudo systemctl status markdown-lab
```

查看日志：

```bash
sudo journalctl -u markdown-lab -f
```

### 5. 配置 Nginx 反向代理

创建站点配置：

```text
/etc/nginx/sites-available/markdown-lab
```

内容如下：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/markdown-lab /etc/nginx/sites-enabled/markdown-lab
sudo nginx -t
sudo systemctl reload nginx
```

### 6. HTTPS（推荐）

如果有域名，建议使用 Certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 管理员面板 Cookie 暗号设置方法

### 服务端设置暗号

服务端通过环境变量控制管理员暗号：

```bash
ADMIN_COOKIE_CODE=1145
```

如果你要改成别的值，例如 `9527`：

```bash
ADMIN_COOKIE_CODE=9527 npm start
```

或者在 systemd 里改：

```ini
Environment=ADMIN_COOKIE_CODE=9527
```

修改后重启服务：

```bash
sudo systemctl restart markdown-lab
```

### 浏览器设置管理员 Cookie

打开网站后，在浏览器控制台执行：

```js
document.cookie = "admin=1145; path=/";
```

如果你把服务端暗号改成了 `9527`，则改为：

```js
document.cookie = "admin=9527; path=/";
```

然后刷新页面。

管理员面板会显示在左侧栏中。

> 注意：当前前端默认按 `1145` 判断是否显示管理员面板。如果你修改了服务端暗号，也应同步修改前端逻辑，或者直接手工设置为当前前端支持的暗号值。

---

## 管理员可配置项

管理员面板当前支持：

- `maxPerson`：每个房间最大在线人数
- `bannedWords`：用户名 / 房间名违禁词

默认值：

```text
maxPerson = 5
bannedWords = 78, 91, sb
```

说明：

- 违禁词匹配为“包含即拦截”
- 匹配时不区分大小写
- 用户名和房间名都受此规则约束

---

## API 说明

### `GET /api/rooms`

返回房间列表、当前公共设置、服务器负载。

### `GET /api/admin/rooms?admin=1145`

管理员查看房间列表、设置、服务器负载。

### `POST /api/admin/settings`

请求体示例：

```json
{
  "admin": "1145",
  "maxPerson": 8,
  "bannedWords": ["78", "91", "sb"]
}
```

---

## 注意事项

1. 当前数据为内存存储，服务重启后会丢失
2. 如果部署在 Nginx 后，必须保留 WebSocket 升级头
3. 管理员暗号请不要写成公开弱口令，生产环境建议改掉默认值
4. 若你修改管理员暗号，建议同步调整前端显示条件

---

## 启动摘要

最简部署流程：

```bash
npm install
ADMIN_COOKIE_CODE=1145 DEFAULT_MAX_PERSON=5 npm start
```

浏览器访问：

```text
http://localhost:3000
```
