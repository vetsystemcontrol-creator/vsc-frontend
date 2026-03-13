@echo off
title Vet System Control - Equine
cls

set PORT=8081
set HOST=127.0.0.1

echo ==========================================
echo Vet System Control - Equine
echo Iniciando ambiente local
echo ==========================================
echo.

echo Verificando Node...
node -v
echo.

echo Iniciando Cloudflare Pages local dev...
echo.

npx wrangler pages dev . --ip %HOST% --port %PORT%

pause