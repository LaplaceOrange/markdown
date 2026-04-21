# Markdown Lab

基于 Node.js + Express + Socket.IO 的 Markdown 在线预览与协作网页服务器。

## 功能概览

- 单人模式：仅在当前浏览器页面内存中编辑与预览
- 合作模式：通过房间共享同一份 Markdown 文本
- Markdown 解析：`marked.js`（浏览器端）
- 代码高亮：`highlight.js`（浏览器端）
- 用户系统：基于 Cookie + IP 绑定的虚拟账号，同一 IP 在不同浏览器下默认复用同一账户
- 管理员入口：访问 `/admin`，管理员账户名为 `admin`
- 管理员登录：输入管理员暗号后写入 `adminpass` Cookie，服务端按 Cookie 校验权限
- 管理员面板：查看全部房间、在线玩家、服务器负载、系统属性
- 管理员能力：删除任意房间、封禁指定在线玩家、修改管理员暗号
- 玩家封禁：被封禁玩家仍可查看房间列表并进入房间，但无法创建房间、删除房间、修改房间内容
- 房间限制：每个账户最多创建 3 个房间，每个房间最多 `maxPerson` 人在线
- 在线成员列表：所有成员可见
- 房间日志窗口：房间内可查看内容变更日志，区分哪个用户添加/删除了内容
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
- 房间编辑日志
- 房主信息
- 在线成员
- 管理员设置（当前进程生命周期内有效）
- IP 与用户映射
- 封禁玩家列表

这意味着：

- **重启服务后数据会丢失**
- **管理员暗号运行期可在后台修改，但服务重启后仍回到环境变量默认值**
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

## 管理员登录与后台说明

### 管理员暗号来源

服务端启动时通过环境变量读取默认管理员暗号：

```bash
ADMIN_COOKIE_CODE=1145
```

例如改成 `9527`：

```bash
ADMIN_COOKIE_CODE=9527 npm start
```

或者在 systemd 中配置：

```ini
Environment=ADMIN_COOKIE_CODE=9527
```

### 登录管理员

当前版本不再使用旧的 `admin=1145` Cookie 方案。

正确流程为：

1. 打开网站，或直接访问：

```text
http://localhost:3000/admin
```

2. 将当前昵称改为：

```text
admin
```

3. 点击“保存昵称”后，输入管理员暗号
4. 校验成功后，浏览器会写入：

```text
adminpass=<base64后的管理员暗号>
```

5. 此后访问 `/admin` 即可进入管理员页面

若未登录或暗号错误，访问 `/admin` 会显示“无权限访问”。

### 管理员可做什么

管理员页面位于右侧主内容区，当前支持：

- 查看全部房间
- 删除任意房间
- 查看在线玩家
- 封禁指定在线玩家
- 查看服务器负载
- 设置房间人数上限
- 设置违禁词
- 查看 / 编辑封禁玩家列表
- 修改管理员暗号

### 修改管理员暗号

管理员页面“属性设置”中提供：

```text
新管理员暗号（数字/字母）
```

- 留空：不修改暗号
- 输入后保存：当前运行中的管理员暗号立即更新
- 更新成功后：旧暗号失效，新暗号生效

> 注意：管理员暗号的运行期修改仅保存在内存中。若服务重启，仍会回到 `ADMIN_COOKIE_CODE` 环境变量对应的值。

---

## 管理员可配置项

管理员面板当前支持：

- `maxPerson`：每个房间最大在线人数
- `bannedWords`：用户名 / 房间名违禁词
- `bannedPlayers`：被封禁玩家列表
- `adminCode`：运行期管理员暗号

默认值：

```text
maxPerson = 5
bannedWords = 78, 91, sb
```

说明：

- 违禁词匹配为“包含即拦截”
- 匹配时不区分大小写
- 用户名和房间名都受此规则约束
- `admin` 不会被加入违禁词列表
- 被封禁玩家仍可查看房间列表并进入房间，但不能创建房间、删除房间、修改内容

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
  "maxPerson": 8,
  "bannedWords": ["78", "91", "sb"],
  "bannedPlayers": ["UserA", "UserB"],
  "adminCode": "9527"
}
```

### `POST /api/admin/players/ban`

请求体示例：

```json
{
  "username": "UserA"
}
```

### `DELETE /api/admin/rooms/:roomId`

管理员删除指定房间。

---

## 注意事项

1. 当前数据为内存存储，服务重启后会丢失
2. 如果部署在 Nginx 后，必须保留 WebSocket 升级头
3. 管理员暗号请不要写成公开弱口令，生产环境建议改掉默认值
4. `adminpass` 为浏览器端 base64 编码值，不是强安全加密方案，更适合内网 / 轻量管理场景
5. 若需要长期保留房间、日志、封禁列表或暗号，需自行增加持久化存储

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
