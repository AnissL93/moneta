#!/bin/sh
set -e
npx prisma migrate deploy --schema /app/apps/server/prisma/schema.prisma
exec node /app/apps/server/dist/index.js
