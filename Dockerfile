# Imagen base
FROM node:20-alpine

# Instalar dependencias del sistema INCLUYENDO OpenSSL
RUN apk add --no-cache \
    openssl \
    openssl-dev \
    libc6-compat

# Directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./
COPY tsconfig.json ./

# Instalar dependencias
RUN npm install

# Copiar archivos Prisma
COPY prisma ./prisma

# Generar Prisma Client
RUN npx prisma generate

# Copiar código fuente
COPY src ./src

# Compilar TypeScript
RUN npm run build

# Exponer puerto
EXPOSE 8080

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=8080

# Comando de inicio
CMD ["npm", "start"]