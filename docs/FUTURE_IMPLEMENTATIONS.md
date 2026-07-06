# Lumi AI - Mejoras Futuras y Roadmap

Este documento recopila las ideas, limitaciones técnicas actuales y propuestas de funcionalidades avanzadas que pueden implementarse en el futuro para llevar la extensión al siguiente nivel.

## 1. Herramienta de Inyección de JavaScript (Manipulación Directa del DOM)
**Problema actual:**  
El agente actualmente utiliza eventos de ratón y teclado simulados (RPA visual). Esto funciona muy bien para inputs estándar, pero falla estrepitosamente al interactuar con **Editores de Texto Enriquecido (Rich Text Editors)** como TinyMCE, Quill o CKEditor, ya que estos ocultan el `<textarea>` original y usan iframes o capas especiales (`contenteditable`) que interceptan los eventos.

**Solución futura:**  
Añadir una nueva herramienta al arsenal de la IA llamada `execute_javascript`. Esto le permitirá al agente inyectar y ejecutar pequeños scripts directamente en el contexto de la página (ej. `document.querySelector('#editor').value = 'texto'`) para forzar cambios en elementos rebeldes cuando el enfoque visual falle.

## 2. Interceptación y Análisis de Red (Network Tab API)
**Problema actual:**  
Llenar formularios largos paso por paso de forma visual toma mucho tiempo y puede romperse si la interfaz cambia de posición o carga lento. 

**Solución futura:**  
Implementar el uso de `chrome.webRequest` o `chrome.debugger` para darle a la IA la capacidad de **ver, interceptar y replicar peticiones HTTP (Network Tab)**. 
- La IA podría observar cómo funciona un formulario y, en lugar de mover el ratón, enviar los datos directamente mediante un `fetch()` o petición API en segundo plano.
- **Retos a superar:** Manejar tokens de seguridad (CSRF), cookies de sesión complejas y sistemas anti-bots modernos que requieren validaciones de comportamiento humano.

## 3. Soporte Completo de Markdown y Renderizado Avanzado
**Problema actual:**  
El renderizado del chat tiene expresiones regulares básicas que parsean bien código y textos en negrita/cursiva, pero fallan con tablas o listas anidadas complejas.

**Solución futura:**  
Integrar una librería ligera como `marked.js` o `DOMPurify` para parsear y esterilizar el 100% de la sintaxis Markdown que devuelva DeepSeek (incluyendo tablas, bloques de citas, listas y enlaces) de forma nativa.

## 4. Herramientas Avanzadas de Interacción para el Agente Autónomo
Para que Lumi AI navegue impecablemente por cualquier página web del mundo, sin tropezar con obstáculos modernos, se deben añadir las siguientes herramientas a su cerebro:

- **`press_key` (Teclado Virtual Completo):** Muchas páginas (como Notion, Trello, o Gmail) dependen de atajos de teclado. La IA necesita poder enviar comandos como `Enter`, `Escape`, `Tab` o `Ctrl+C`.
- **`drag_and_drop` (Arrastrar y Soltar):** Fundamental para mover tarjetas en tableros Kanban, reordenar listas o resolver ciertos puzzles interactivos.
- **`switch_iframe` (Buceo en Marcos):** Muchas pasarelas de pago (Stripe) y reproductores (YouTube) viven dentro de un "iframe" aislado. La IA necesita una herramienta para "saltar" adentro de esos iframes, mapearlos y hacer clics ahí adentro, ya que actualmente están ciegos a ellos.
- **`upload_file` (Subida de Archivos):** Darle a la IA la capacidad de interactuar con campos `<input type="file">` e inyectar archivos locales o generar archivos falsos (PDFs, imágenes de prueba) para formularios que exigen adjuntos.
- **`wait_for_network_idle` (Paciencia de Red):** En lugar de que la IA espere 2 segundos "adivinando" si la página ya cargó, una herramienta que ponga a la IA a dormir hasta que todas las peticiones de red (Spinners, Loadings) hayan terminado.
- **`solve_captcha` (Derribo de Anti-Bots):** Integración con servicios de terceros (como 2Captcha o Anti-Captcha) para que, si la IA se topa con un "No soy un robot", envíe la imagen al servicio y resuelva el desafío por sí misma.
