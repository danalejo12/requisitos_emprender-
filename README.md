# Requisitos para la formación de un emprendimiento

Proyecto del GAES 1, por Daniel Velasco y Miguel Ortiz. Incluye la presentación y un juego de preguntas con panel de administrador.

## Contenido

- `GAES1_Requisitos_Emprendimiento.pptx`: presentación con notas del orador.
- `juego/`: "La Ruta del Emprendedor", un juego de 10 preguntas con puntaje por velocidad y racha.

## Cómo ejecutar el juego

Si cada persona juega en su celular, se necesita Node.js 18 o superior, sin dependencias adicionales:

```bash
cd juego
node server.js
```

En Windows también se puede abrir `iniciar.bat`. La consola muestra el enlace para los jugadores y, en el primer arranque, la contraseña de administrador. Todos los dispositivos deben estar en la misma red.

Si todos juegan en un solo computador, basta con abrir `juego/juego.html` con doble clic.

Las instrucciones completas y los límites de seguridad están en `juego/LEEME.txt`.

## Datos locales

El servidor guarda los puntajes y la contraseña derivada en `juego/datos/`. Esa carpeta está excluida de Git y no debe subirse al repositorio.
