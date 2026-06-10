# Política de Privacidad de Layla

Última actualización: 10 de Junio de 2026

Layla es un bot de inteligencia artificial conversacional diseñado para interactuar en servidores de Discord mediante voz y texto. Esta política describe cómo manejamos la información para garantizar la privacidad y seguridad de todos los usuarios.

## 1. Qué datos procesamos
Para poder ofrecer sus funciones de interacción natural, Layla requiere acceso a:
- **Flujos de Audio:** El audio de los canales de voz en los que el bot participa.
- **Mensajes de Texto:** Los comandos y mensajes enviados en los canales de texto donde Layla ha sido activada explícitamente por un administrador (vía `/talk`).
- **Metadatos Básicos:** ID de usuario y nombre en el servidor (para saber quién le habla) e ID del canal/servidor (para mantener las sesiones separadas).

## 2. Cómo se procesa la información
- **Uso Estrictamente Efímero:** El audio recibido se procesa directamente en la memoria volátil (RAM). **Layla NO graba, NO guarda y NO almacena archivos de audio en ningún servidor físico.**
- **Motor de Escucha Local (Wake Word):** Para respetar la privacidad en llamadas grupales, Layla cuenta con un motor de reconocimiento de voz *offline* local que únicamente busca la palabra "Layla" para despertar. El audio descartado nunca sale de tu servidor hacia la nube.
- **Procesamiento de Inteligencia Artificial:** Cuando Layla despierta o conversa contigo, el audio o texto necesario para formular su respuesta es procesado a través de la API de **Google (Gemini)** en tiempo real.
- **Amnesia Programada:** Layla está programada para olvidar. El contexto a corto plazo de las conversaciones se purga automáticamente cada vez que se reinicia el ciclo de conexión (cada pocos minutos) o cuando hay inactividad, eliminándose sin dejar rastro.

## 3. Uso de la Información y Terceros
La información recopilada tiene **como único y exclusivo propósito** el funcionamiento técnico del bot y la generación de las respuestas en tiempo real. 
- No se construyen perfiles de usuario.
- Tus datos, voz o mensajes jamás serán vendidos, compartidos con terceros para fines publicitarios, ni utilizados para entrenar modelos de IA internos.

## 4. Eliminación de Datos
Dado que Layla no almacena historiales de chat ni logs de audio en bases de datos, no existen datos almacenados permanentemente vinculados a los usuarios que requieran eliminación manual.

Al utilizar Layla, estás de acuerdo con esta política. Si tienes preguntas o preocupaciones sobre el manejo de privacidad, por favor contacta al desarrollador de la aplicación.
