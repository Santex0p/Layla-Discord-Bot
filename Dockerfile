# 1. Usa una imagen oficial de Node.js (la versión 20 es excelente y ligera)
FROM node:20-slim

# 2. Crea la carpeta donde vivirá tu bot dentro del contenedor
WORKDIR /app

# 3. Copia SOLO los archivos de dependencias primero (esto hace que Docker sea más rápido)
COPY package*.json ./

# 4. Instala las dependencias (el equivalente a lo que harías en tu máquina)
RUN npm install

# 5. Ahora sí, copia el resto del código de tu bot al contenedor
COPY . .

# 6. El comando maestro que tú usas para encenderlo
CMD ["npm", "start"]
