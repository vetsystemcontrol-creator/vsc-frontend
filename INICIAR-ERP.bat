@echo off
title Vet System Control - Equine
cls

REM ==========================================================
REM INICIAR-ERP.bat — SERVIDOR LOCAL ERP
REM Arquitetura: Frontend SPA/PWA
REM Porta: 8081
REM ==========================================================

set PORT=8081
set ROOT=%~dp0

echo ===============================================
echo Vet System Control - Equine
echo Servidor Local ERP
echo Pasta : %ROOT%
echo Porta : %PORT%
echo URL   : http://127.0.0.1:%PORT%/login.html
echo ===============================================
echo.

REM ----------------------------------------------------------
REM Verificar Node.js
REM ----------------------------------------------------------

where node >nul 2>nul
if not %errorlevel%==0 (
    echo ERRO: Node.js nao encontrado no sistema.
    echo Instale Node.js LTS:
    echo https://nodejs.org
    pause
    exit
)

echo Node encontrado:
node -v
echo.

REM ----------------------------------------------------------
REM Ir para pasta do sistema
REM ----------------------------------------------------------

cd /d "%ROOT%"

REM ----------------------------------------------------------
REM Iniciar servidor HTTP local
REM ----------------------------------------------------------

echo Iniciando servidor ERP...
echo.

npx serve -l %PORT% .

echo.
echo ERP finalizado.
pause