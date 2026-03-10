# 1. Use an official Node.js runtime as a parent image
FROM node:18-slim

# 2. Install FFmpeg and essential build tools
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libwebp-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# 3. Set the working directory
WORKDIR /app

# 4. Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# 5. Copy the rest of your bot's code
COPY . .

# 6. Start the bot
CMD ["node", "index.js"]
