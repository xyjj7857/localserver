FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build frontend
RUN npm run build

# Expose port
EXPOSE 3000

# Start the server
# Note: server.ts is run directly via node in the start script
# Node 22+ supports stripping types automatically
CMD ["npm", "start"]
