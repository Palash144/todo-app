# ==============================================================================
# Stage 1: Build the Go binary
# ==============================================================================
FROM golang:alpine AS builder

WORKDIR /build

# Copy Go module files
COPY go.mod ./
RUN go mod download || true

# Copy Go source code
COPY main.go ./

# Compile statically linked Go executable
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o taskflow-server main.go

# ==============================================================================
# Stage 2: Minimal runtime container
# ==============================================================================
FROM alpine:latest

# Install CA certificates and tzdata for SSL/Timezone support
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user and group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Create directory for persistent data store
RUN mkdir -p /app/data && chown -R appuser:appgroup /app

# Copy binary and frontend assets
COPY --from=builder /build/taskflow-server /app/taskflow-server
COPY index.html /app/index.html
COPY styles.css /app/styles.css
COPY app.js /app/app.js

# Switch to non-root user
USER appuser

# Environment variables
ENV PORT=8080 \
    STATIC_DIR=/app \
    DATA_PATH=/app/data/tasks.json \
    IN_CONTAINER=true

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/api/stats || exit 1

# Start the application
CMD ["/app/taskflow-server", "--no-browser"]
