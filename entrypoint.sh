#!/bin/sh
rm -f /app/.wwebjs_auth/session/Singleton*
exec node index.js
