# API Routes

Base URL: `http://localhost:5000/api`

All responses follow the shape `{ "success": true/false, ... }`. Errors return:

```json
{ "success": false, "error": { "message": "..." } }
```

Authenticated requests need a JWT returned by login:

```
Authorization: Bearer <token>
```

---

## Public

### GET /api/health

Server health check. No params.

```json
{ "success": true, "status": "ok", "uptime": 12.34 }
```

### POST /api/auth/team/login

Params (JSON body): `teamName` (string, required), `password` (string, required).

```json
{ "success": true, "token": "eyJ...", "teamId": 1, "teamName": "Alpha" }
```

Errors: `400` missing fields, `401` wrong credentials, `403` team deactivated.

### POST /api/auth/admin/login

Params (JSON body): `username` (string, required), `password` (string, required).

```json
{ "success": true, "token": "eyJ...", "role": "admin", "adminId": 1, "username": "admin" }
```

Errors: `400` missing fields, `401` wrong credentials.

---

## Any authed role

### GET /api/auth/me

No params. Requires any valid token. Returns the token's identity:

```json
{ "success": true, "sub": "1", "role": "team", "teamId": 1, "teamName": "Alpha" }
```

admin token instead returns `role`, `adminId`, `username`.

### POST /api/auth/logout

No params. Requires any valid token. Tokens are stateless; the client should discard it.

```json
{ "success": true, "message": "Logged out. Discard the token on the client side." }
```

---

## Team only

### POST /api/auth/team/change-password

Requires a team token. Params (JSON body): `currentPassword`, `newPassword` (both required; new min 6 chars, max 72, must differ from current).

```json
{ "success": true, "message": "Password updated", "teamId": 1, "teamName": "Alpha" }
```

Errors: `400` validation, `401` wrong current password, `404` team not found.

---

## Admin only

### POST /api/auth/admin/change-password

Requires an admin token. Params (JSON body): `currentPassword`, `newPassword` (same rules as above).

```json
{ "success": true, "message": "Password updated", "adminId": 1, "username": "admin" }
```

### GET /api/admin/teams

No params. Lists all teams.

```json
{
  "success": true,
  "teams": [
    { "id": 1, "teamName": "Alpha", "isActive": true, "createdAt": "2026-10-23T17:16:30.792Z" }
  ]
}
```

### POST /api/admin/teams

Params (JSON body): `teamName` (string, required), `password` (string, required, min 4 chars). Creates a new team.

```json
{ "success": true, "team": { "id": 3, "teamName": "Beta", "isActive": true, "createdAt": "..." } }
```

Errors: `400` validation, `409` name already exists.

### PUT /api/admin/teams/:id

Param `:id` — team id in the URL path. Params (JSON body), all optional but at least one required: `teamName`, `password` (min 4), `isActive` (boolean).

```json
{ "success": true, "team": { "id": 3, "teamName": "Betta", "isActive": false, "createdAt": "..." } }
```

Errors: `400` nothing to update / validation, `404` unknown id, `409` name clash.

### DELETE /api/admin/teams/:id

Param `:id` — team id in the URL path. Removes the team and its bids, assignment, and score.

```json
{ "success": true, "message": "Team removed" }
```

Errors: `404` unknown id.

### PATCH /api/admin/teams/:id/toggle

Param `:id` — team id in the URL path. Flips `isActive` on/off. Deactivated teams are rejected at login with 403.

```json
{ "success": true, "team": { "id": 3, "teamName": "Betta", "isActive": true } }
```

Errors: `404` unknown id.

---

## Unauthenticated responses

Any protected endpoint without a valid token returns:

- `401` `{ "message": "Authentication token is missing" }`
- `401` `{ "message": "Authentication token has expired" }`
- `401` `{ "message": "Invalid authentication token" }`
- `403` `{ "message": "This endpoint is restricted to <role> accounts" }` (wrong role)
