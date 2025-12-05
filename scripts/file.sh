#!/bin/bash

# Define root directory
ROOT_DIR="script-manager-app"

echo "Creating project structure..."

# Create directories
mkdir -p $ROOT_DIR/logs
mkdir -p $ROOT_DIR/public

# Create files
touch $ROOT_DIR/server.js
touch $ROOT_DIR/package.json
touch $ROOT_DIR/config.json
touch $ROOT_DIR/savedScripts.json
touch $ROOT_DIR/schedules.json
touch $ROOT_DIR/public/index.html
touch $ROOT_DIR/public/styles.css
touch $ROOT_DIR/public/app.js

echo "All files and folders created successfully!"

# Optional: Add basic content templates
echo "// Node.js backend server" > $ROOT_DIR/server.js
echo "{}" > $ROOT_DIR/package.json
echo "{}" > $ROOT_DIR/config.json
echo "[]" > $ROOT_DIR/savedScripts.json
echo "[]" > $ROOT_DIR/schedules.json

echo "<!-- Main HTML file -->" > $ROOT_DIR/public/index.html
echo "/* Custom CSS */" > $ROOT_DIR/public/styles.css
echo "// Frontend JavaScript" > $ROOT_DIR/public/app.js

echo "Template contents added!"
echo "Done."