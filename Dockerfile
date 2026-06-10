FROM node:20-slim

# Instalar dependencias del sistema necesarias para compilar @discordjs/opus (node-gyp)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 3. Copia SOLO los archivos de dependencias primero (esto hace que Docker sea más rápido)
COPY package*.json ./

# 4. Instala las dependencias (el equivalente a lo que harías en tu máquina)
RUN npm install

# 5. Ahora sí, copia el resto del código de tu bot al contenedor
COPY . .

# 6. El comando maestro que tú usas para encenderlo
CMD ["npm", "start"]
