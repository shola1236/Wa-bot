# Use a full version of Node to ensure all build tools are available
FROM node:18

# Install FFmpeg and other essentials
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files FIRST (this helps with caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Bundle app source
COPY . .

# Start the bot
CMD [ "node", "index.js" ]
