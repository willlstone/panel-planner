@echo off
rem Starts a local web server for Panel Planner and opens it in your browser.
cd /d "%~dp0"
start "" http://localhost:8173/index.html
python -m http.server 8173 --bind 127.0.0.1
