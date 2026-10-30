@echo off
echo ============================================
echo   Gourmet Manager Pro - POS 
echo   Avtomatik chop etish rejimi yoqilgan!
echo ============================================
echo.
echo Server ishga tushmoqda...
echo To'xtatish: Ctrl+C
echo.
start "" chrome --kiosk-printing --app=http://localhost:5000
C:\php\php.exe -S localhost:5000 index.php
pause
