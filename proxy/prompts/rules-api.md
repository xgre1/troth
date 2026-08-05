# API/REST Endpoint Rules (in-context)

You are working with API/route/endpoint code. Apply these rules:

- Validate request body BEFORE database operations. Return 400 with `{error: "..."}` on bad input.
- Always handle the "not found" case. Return 404 with `{error: "..."}` not 200 with empty data.
- Wrap database calls in try/catch. Return 500 only for true server errors, never for validation failures.
- For DELETE: check the row exists first, return 404 if not. Return 204 (no content) on success, not 200.
- For PUT/PATCH: confirm the resource exists before updating. Return updated resource as JSON.
- Status codes: 200 OK, 201 Created (POST), 204 No Content (DELETE), 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 429 Rate Limit, 500 Server Error.
- Filter parameters: read from `req.query`, validate values are in allowed set before using.
