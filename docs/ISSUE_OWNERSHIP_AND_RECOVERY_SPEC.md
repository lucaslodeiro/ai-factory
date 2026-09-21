# Exclusividad por issue y recuperación entre factories

> Propuesta diferida por decisión del usuario: por ahora se asume una sola Factory por repositorio y se elimina la protección y takeover global sin sustituirlos por reservas por issue. Este documento conserva ideas futuras; no es el alcance de implementación vigente.

Estado: propuesta para revisión; no implementada ni aprobada.

## 1. Objetivo y decisiones de producto

Reemplazar el controlador exclusivo de repositorio por exclusividad por issue. Varias factories pueden trabajar en distintos issues del mismo repositorio. Una Factory puede liberar un issue para que otra continúe desde un punto de recuperación publicado, conservando código, etapa, decisiones y contexto. La continuidad debe aceptar trabajo avanzado por otra Factory, por un desarrollador humano o por ambos: la autoría del código no determina si puede recuperarse.

Requisitos acordados:

- Exclusividad por issue, no por cuenta ni por repositorio.
- Liberación explícita, con progreso publicado antes de completar la transferencia.
- Contexto portable, versionado en el repositorio.
- Commits y push parciales durante el trabajo, sin esperar a Delivery.
- Sincronización con cambios externos de la rama de trabajo y la rama base mediante merge, sin sobrescribirlos.
- Dashboard con estado real de propiedad, progreso local, progreso publicado y bloqueos.

No se promete trasladar procesos, memoria de un agente, puertos, dependencias instaladas ni cambios que nunca llegaron al remoto. Un checkpoint parcial no significa que Build, Test o Review hayan terminado satisfactoriamente.

## 2. Situación actual verificada

- `src/controller-lease.ts` mantiene una reserva global en `refs/ai-factory/lease`.
- `src/daemon.ts` condiciona ejecución y sincronización al controlador global.
- `src/workflow-runner.ts` hace commits después de Builder/Tester; publica la rama en Delivery. Los agentes no pueden crear commits: el orquestador los controla.
- `src/worktrees.ts` recupera ramas remotas al crear un worktree, pero no implementa el protocolo de recuperación y sincronización descrito aquí.
- Etapas, especificaciones, solicitudes, decisiones y fallos viven principalmente en SQLite local.
- El takeover cambia el controlador, pero no importa ese estado ni los cambios locales.

La implementación deberá revisar también los caminos de CLI, dashboard, mantenimiento, publicación de GitHub, notificaciones y desinstalación. Quitar únicamente los botones de takeover no satisface esta especificación.

## 3. Identidad e invariantes

La clave de exclusividad es `(GitHub repository ID, GitHub issue ID)`, con sus node IDs para validación. El número de issue es solo presentación. Renombrar un repositorio no crea una reserva nueva; un issue recreado no hereda el trabajo de otra identidad.

Invariantes obligatorios:

1. Solo un propietario puede tener autorización vigente para ejecutar y publicar trabajo de un issue.
2. Toda adquisición nueva recibe una generación mayor; el propietario anterior no puede publicar con una generación vieja.
3. Una Factory que no puede renovar deja de admitir acciones y detiene el agente antes de agotar su autorización local. No sigue trabajando indefinidamente desconectada.
4. Un checkpoint solo está publicado cuando código, contexto y referencia de control quedan confirmados conjuntamente en el remoto.
5. Liberar no descarta archivos ni requiere reiniciar el issue desde Design.
6. Nunca se fuerza un push para eliminar cambios externos de la rama de trabajo.
7. Un merge o una recuperación no convierte resultados anteriores en válidos para código diferente.
8. Las reservas no se toman automáticamente por observar un issue ajeno o por vencer su plazo.
9. Los permisos de escritura por rol siguen aplicando a todos los commits parciales.

La garantía aplica a factories que cumplen el protocolo. Un usuario con permisos de escritura puede modificar refs manualmente; se detectará como pérdida de propiedad o inconsistencia. No se debe prometer impedir por software local toda ejecución física de un proceso en una máquina congelada o aislada: la protección decisiva son el vencimiento local y el rechazo remoto de publicaciones obsoletas.

## 4. Modelo remoto propuesto

Por issue:

- Rama de código asignada, conservando la existente cuando haya trabajo previo. Para nuevos issues, nombre estable derivado de su identidad.
- Ref de coordinación `refs/ai-factory/issues/<issue-id>`, con un documento JSON versionado.
- Contexto portable en `.ai-factory/issues/<issue-id>/checkpoint.json` y un `HANDOFF.md` legible dentro de la rama de trabajo.

Documento de coordinación mínimo:

- Versión del protocolo, IDs de repositorio e issue.
- Propietario: ID de instalación, nombre visible, ID de sesión de daemon.
- Generación, instante de renovación y vencimiento.
- Estado de propiedad: `owned` o `released`.
- Rama asignada, ID de checkpoint y SHA publicado de código/contexto.
- Revisión de control y último evento de liberación/adquisición.

Una liberación deja un registro persistente, no borra la ref ni reinicia la generación. Cada arranque del daemon tiene una sesión distinta para impedir que un proceso anterior con el mismo ID de instalación renueve en nombre del nuevo.

El JSON del checkpoint no puede contener el SHA del commit que lo contiene: sería una referencia circular. Incluye ID de checkpoint y SHA padre/base; el documento de coordinación vincula el checkpoint con el SHA final.

### 4.1 Escrituras atómicas y publicación

Todas las modificaciones de propiedad usan compare-and-swap sobre el SHA exacto observado de la ref de coordinación. No basta con leer el propietario y hacer un push ordinario después.

Propuesta a validar:

- Adquirir y renovar actualizan la ref de coordinación mediante CAS.
- Publicar un checkpoint actualiza rama de trabajo y ref de coordinación en un único `git push --atomic`, condicionado a los dos SHAs observados.
- La nueva punta de código debe descender de la punta remota observada; el orquestador lo comprueba expresamente. Un mecanismo CAS no autoriza reescribir historia.
- Si falla cualquier condición, no se considera publicado ninguno de los dos cambios. Se vuelve a leer, clasificar y reconciliar; no se reintenta a ciegas.
- Si el servidor no soporta refs o pushes atómicos requeridos, se informa incompatibilidad. No hay fallback a dos pushes que puedan dejar un checkpoint inconsistente.
- Renovación, checkpoint y liberación de un mismo issue se serializan localmente. Distintos issues tienen colas independientes.

Los agentes no reciben responsabilidad de publicar, renovar o liberar. El orquestador conserva estas operaciones y sus controles.

### 4.2 Duración y particiones de red

Valores iniciales propuestos: reserva de 120 segundos, renovación cada 30 segundos, margen local de detención de 30 segundos. Los comandos de red deben tener plazos acotados y ejecutarse fuera del hilo que atiende controles y dashboard.

Se requiere reloj monotónico para el plazo local y una política explícita para desfase de relojes entre máquinas. El protocolo no se aprobará suponiendo relojes perfectamente sincronizados: el revisor debe validar cómo se decide el vencimiento remoto y qué margen/validación se exige para recuperar una reserva vencida.

Al perder conectividad: mostrar “Propiedad sin verificar”, bloquear nuevas ejecuciones y, antes del límite, interrumpir y confirmar salida del árbol de procesos. Conservar cambios locales, pero no presentarlos como recuperables desde otra máquina. Si vuelve la conexión, verificar propietario y generación antes de cualquier publicación.

## 5. Contexto portable

El checkpoint es un formato de intercambio con esquema validado, no un volcado de SQLite.

Incluye:

- Identidad estable de issue y workflow; rama y rama base, SHAs de base y entrada de ejecución.
- Etapa, estado lógico, siguiente acción y motivo de espera, pausa o fallo.
- Especificaciones, criterios de aceptación y aprobaciones con identidad/procedencia.
- Decisiones humanas, consultas, respuestas, instrucciones vigentes y relaciones entre registros.
- Resúmenes de resultados, hallazgos pendientes y verificaciones con el SHA al que corresponden.
- PR asociado, intentos/ciclos relevantes y cursor de comentarios procesados.
- Claves estables de idempotencia para no repetir respuestas, decisiones o publicaciones tras importar.
- Trabajo parcial, qué falta y si la ejecución fue interrumpida para guardar progreso.
- Capacidades de entorno requeridas; no asumir que están presentes en el destino.

Excluye credenciales, `.env`, tokens, PID, rutas absolutas, sockets, perfiles de navegador, dependencias, cachés y logs brutos. Solo se exportan campos permitidos; se aplican límites de tamaño y validación de rutas. No se asume que filtrar nombres de archivos basta para excluir secretos dentro de texto o código.

Los archivos de contexto son responsabilidad del orquestador. Se protege su integridad frente a cambios accidentales de agentes; al importar se validan referencias, esquema, identidad y coherencia con el commit. Su texto es información de trabajo, no una fuente de permisos nuevos ni instrucciones de sistema.

La importación es transaccional e idempotente. No importa IDs autoincrementales locales como identidades globales ni duplica notificaciones. Conserva evidencia histórica sin restaurar ejecuciones como procesos activos.

## 6. Cuándo guardar y publicar progreso

Publicar checkpoints:

- Al iniciar o recuperar el issue.
- Tras cada resultado de agente y decisión humana que cambie el flujo.
- Al pausar, fallar de manera recuperable o preparar una liberación.
- Durante ejecuciones largas, con objetivo inicial de cinco minutos entre checkpoints seguros.

No hacer commits sobre archivos que el agente continúa escribiendo ni mover HEAD durante una ejecución cuyo contrato espera una base inmutable. La implementación debe introducir límites de ejecución seguros:

1. Solicitar pausa cooperativa si el adaptador la soporta.
2. Si no existe esa capacidad, interrumpir de forma controlada y esperar la salida del árbol de procesos.
3. Capturar y validar el delta según el rol; excluir archivos prohibidos y comprobar que no haya operaciones Git incompletas.
4. Crear commit WIP y contexto, sincronizar y publicar atómicamente.
5. Si el trabajo sigue autorizado, iniciar una nueva ejecución desde ese checkpoint, conservando la misma etapa y los pendientes.

La interrupción para checkpoint no cuenta como error del agente ni consume ciclos de corrección. No se aplica un resultado truncado como si fuera válido. Si el agente no puede detenerse con seguridad, mostrar el bloqueo; no guardar una mezcla inconsistente de archivos.

El intervalo de cinco minutos es un objetivo, no una garantía ante falta de red, procesos que no terminan o cambios no publicables. El dashboard muestra antigüedad del último checkpoint y riesgo de progreso exclusivamente local.

Un push fallido conserva commits locales, deja la publicación pendiente y bloquea el siguiente tramo de ejecución hasta resolverlo. La Factory intenta renovar su reserva mientras pueda hacerlo; si esta vence, aplica el protocolo de pérdida de propiedad.

## 7. Liberar y recuperar

### 7.1 Liberar voluntariamente

Disponible para el propietario mientras el issue tenga trabajo transferible.

1. Mostrar “Guardar progreso y liberar”, con explicación de que otra Factory podrá tomarlo.
2. Impedir nuevos agentes y detener el actual de forma controlada.
3. Guardar el estado de continuación, validar cambios y sincronizar con el remoto.
4. Publicar el checkpoint y marcar la propiedad `released` en la misma transacción remota.
5. Solo después de confirmar el remoto, mostrar “Disponible para continuar”. La copia local pasa a solo lectura y no se reencola sola.

Si el push responde con timeout, releer las refs y buscar el ID de operación/checkpoint: pudo haber terminado. Mientras no se pueda verificar, mostrar “Liberación sin confirmar”, bloquear nuevas ejecuciones y no anunciar éxito ni crear una segunda operación.

Si falla la sincronización, validación o publicación, conservar el progreso y mostrar la causa. No hay “liberar de todos modos” en la primera versión, porque implicaría abandonar progreso no transferido.

### 7.2 Continuar en otra Factory

1. El usuario elige “Continuar aquí” sobre un issue liberado, o “Recuperar aquí” sobre una reserva vencida.
2. Leer propiedad y checkpoint; validar compatibilidad, identidad y disponibilidad de objetos Git.
3. Adquirir con CAS y nueva generación; solo un contendiente puede ganar.
4. Crear un worktree aislado y recuperar contexto con transacción local.
5. Sincronizar cambios externos, validar las capacidades del entorno y determinar qué resultados siguen vigentes.
6. Mostrar el punto recuperado y ejecutar únicamente si existe una continuación válida.

Una tarea que esperaba respuesta humana sigue esperando; una tarea fallida conserva su fallo y requiere Retry. Una ejecución interrumpida vuelve a una etapa reanudable sin fingir que terminó. Nunca reiniciar Design silenciosamente porque falta contexto.

Si falla la recuperación después de adquirir, mantener un estado visible de recuperación fallida, sin ejecutar agentes, y permitir liberar conservando el checkpoint remoto existente. No sobrescribirlo con una importación parcial.

El propietario anterior que reaparece no publica su copia atrasada. Sus cambios inéditos se conservan localmente y pueden rescatarse posteriormente mediante una importación explícita de commits, nunca mediante una renovación con generación obsoleta.

### 7.3 Continuar trabajo humano o de autoría mixta

Son casos de producto de primera clase:

- Otra Factory publicó un checkpoint y un humano añadió commits después.
- Un humano modificó la rama de trabajo, el PR o la rama base mientras la Factory estaba detenida o ejecutando.
- Un humano inició una implementación en una rama/PR que aún no tiene checkpoint de Factory.

Código publicado y contexto de workflow son fuentes complementarias: Git es la autoridad sobre los archivos; el checkpoint acredita decisiones y verificaciones solo para la versión con la que fue publicado. Un commit humano posterior no vuelve corrupto el checkpoint anterior: lo vuelve potencialmente desactualizado y exige reconciliación. Distinguir este caso de un checkpoint modificado, incompatible o con identidad inválida.

Al continuar desde un checkpoint antiguo, leer el historial/diff hasta la punta remota, incorporar los commits humanos sin sustituirlos por el árbol anterior y actualizar el resumen de trabajo y pendientes. Preservar autoría e historia. Los comentarios humanos, mensajes de commit y documentos pueden aportar contexto, pero no equivalen automáticamente a aprobaciones de producto ni resultados de pruebas.

Cuando no existe checkpoint, ofrecer **Incorporar trabajo existente**: seleccionar explícitamente el issue y su rama o PR, comprobar que no estén asignados a otro workflow y adquirir exclusividad antes de ejecutar. La asignación inicial de rama debe usar una comprobación atómica de unicidad en el protocolo, no solo una consulta local; una misma rama de trabajo no puede ser escrita por dos issues aunque sus reservas sean distintas. Las ramas ajenas al prefijo administrado necesitan una política explícita: conservar la rama seleccionada o crear una rama Factory desde su punta, informando cómo continuará el PR existente. No cambiarla silenciosamente.

La Factory inspecciona código, diff, requisitos, PR y evidencia disponible, y propone un punto de continuación con lo que está confirmado y lo que falta. No borra ni reimplementa por defecto el trabajo existente, no inventa un checkpoint anterior y no fuerza volver a Design si ya hay requisitos suficientes. Si falta una decisión o aprobación imprescindible, solicita únicamente esa información; si solo faltan verificaciones, continúa desde la validación correspondiente.

Antes de seguir, publicar el primer checkpoint de incorporación con la procedencia del código y las decisiones efectivamente confirmadas. Un texto “tests passed” en un commit humano no autoriza omitir pruebas. Las verificaciones deben corresponder al código integrado y contar con evidencia aceptada por la política del workflow.

La exclusividad es entre factories cooperantes: no bloquea a un humano con permisos Git. Los pushes humanos concurrentes se detectan mediante sincronización/CAS. Una segunda Factory tampoco puede usar otro issue para escribir en la misma rama asignada: la revisión del protocolo debe cubrir esa exclusividad adicional de rama, manteniendo el paralelismo entre ramas distintas.

## 8. Sincronización y cambios externos

Antes de cada ejecución, checkpoint, liberación y Delivery:

1. Verificar propiedad y detener escritores locales antes de modificar el worktree.
2. Guardar un commit local seguro si hay progreso pendiente.
3. Fetch de la rama de trabajo y de la rama base configurada.
4. Integrar primero la rama remota de trabajo; después la rama base mediante merge.
5. Si no hay conflictos, registrar SHAs nuevos e invalidar verificaciones afectadas.
6. Antes de publicar, verificar otra vez los SHAs esperados mediante CAS. Si cambiaron durante la operación, repetir la reconciliación de forma acotada.

No usar `reset --hard`, selección automática de `ours/theirs`, force push destructivo ni descarte silencioso de archivos. Una reescritura remota, borrado de rama o historia no relacionada detiene el flujo y requiere una decisión explícita.

Un conflicto se presenta como fallo de sincronización, con archivos afectados y acción concreta. La primera versión no resuelve conflictos semánticos automáticamente. Se conserva el commit local y la información del conflicto; puede abortarse el intento de merge para mantener el worktree utilizable sin perder ninguno de los lados. Retry vuelve a sincronizar tras la resolución.

Política inicial conservadora: si cambia código desde la última verificación aprobada, volver a Test y Review antes de Delivery, aunque el merge haya sido limpio. Preservar la aprobación de producto salvo cambios en requisitos/especificación. Cambios solo en metadatos de checkpoint no invalidan pruebas de código; se compara un identificador del árbol de código que excluya esos metadatos.

No se garantiza que la rama base permanezca inmóvil después de comprobarla. El PR debe conservar controles de rama y CI para verificar su estado al hacer merge; no se fusiona automáticamente en la rama base como parte de este protocolo.

## 9. Dashboard y comandos

Eliminar del flujo normal: Repository controller, Release control, Force takeover y el bloqueo global de la lista de issues.

Cada issue muestra, con información actualizada en vivo:

- Propietario y si es esta instalación u otra.
- Estado del workflow, separado del estado de propiedad.
- Último checkpoint publicado: hora, commit y etapa.
- Progreso local pendiente o publicación sin confirmar.
- Estado de sincronización/conflicto y próxima acción comprensible.

Acciones por situación:

| Situación | Acciones |
| --- | --- |
| Propio, activo o en espera | Pause, Cancel, Guardar progreso y liberar |
| Propio, pausado | Resume, Cancel, Guardar progreso y liberar |
| Propio, fallido | Diagnose, Retry, Cancel, Guardar progreso y liberar |
| Ajeno con reserva vigente | Ver detalles y checkpoint; sin controles de ejecución |
| Liberado | Continuar aquí |
| Reserva vencida | Recuperar aquí, con aviso del límite del último checkpoint |
| Sin checkpoint compatible | Diagnóstico/importación explícita; nunca Resume engañoso |
| Propiedad o publicación incierta | Verificar estado; sin acciones que dupliquen la operación |

Cancel no equivale a liberar: registra la cancelación y, tras publicar ese estado, libera sin presentar la tarea como continuación automática. Las tareas completadas publican su último estado y liberan. Pause conserva propiedad mientras el daemon renueve; apagar la máquina no se presenta como liberación confirmada.

KPIs separan trabajos ejecutados aquí de issues remotos visibles. Mensajes largos van en detalles. Mostrar progreso y resultado de adquirir, sincronizar, guardar, liberar y recuperar; nunca solo deshabilitar el botón.

CLI y dashboard deben usar el mismo servicio de coordinación. El agente revisor debe proponer nombres consistentes para los comandos por issue y la retirada de comandos globales existentes.

## 10. Publicación de GitHub y efectos externos

Todas las rutas que escriben Git o GitHub deben quedar cubiertas, incluyendo comentarios, etiquetas, asignaciones, PR y notificaciones. No basta con proteger el scheduler.

Git permite condicionar atómicamente los refs. Las APIs de comentarios/etiquetas de GitHub no comparten esa transacción ni aceptan el token de reserva como condición. Por tanto:

- Verificar propiedad antes de enviar efectos externos, serializarlos por issue y no enviar más al perder autorización.
- Usar generación, checkpoint y claves de idempotencia en publicaciones; reconciliar resultados ambiguos.
- Los comentarios/labels son proyecciones, nunca la autoridad para propiedad o recuperación.
- Un efecto ya enviado puede terminar tarde. Debe ser detectable y corregible por el propietario vigente, sin regresión del estado autoritativo.

El revisor debe comprobar esta limitación expresamente. Una garantía absoluta de fencing para todas las APIs de GitHub exigiría un mediador que las serialice del lado servidor; no debe afirmarse que un check local previo proporciona esa garantía.

## 11. Migración y compatibilidad

No permitir convivencia insegura con daemons que solo conocen la reserva global. Hace falta una barrera de versión/protocolo que las versiones antiguas rechacen de forma cerrada, y un procedimiento explícito de detener y actualizar las instalaciones antiguas antes de activar el nuevo modelo.

El mecanismo exacto de esa barrera es una decisión bloqueante de revisión. No basta con borrar la ref global: una Factory antigua podría adquirirla de nuevo y ejecutar sin conocer reservas por issue.

Para cada workflow existente, la instalación que posee su SQLite y worktree debe exportar y publicar el primer checkpoint. Conservar rama y PR existentes. No reconstruir aprobaciones a partir de etiquetas ni inventar una etapa a partir del texto de un comentario.

Si la instalación original ya no está disponible, ofrecer recuperación parcial desde ramas/PR con límites explícitos y nuevas validaciones. Si falta contexto imprescindible, bloquear continuación automática.

No borrar bases de datos, worktrees, ramas ni historial durante la migración. Los metadatos de recuperación quedan visibles en Git; antes de implementar debe decidirse su tratamiento en el PR y la rama base, sin ocultar cambios al reviewer ni perder recuperabilidad.

## 12. Fallos y criterios de aceptación

La implementación debe demostrar, con remotos Git reales aislados y procesos independientes cuando corresponda:

1. Dos factories disputan el mismo issue: solo una adquiere; con issues distintos ambas avanzan.
2. Carrera entre adquisición, renovación, liberación y checkpoint: CAS impide resultados dobles y regresiones de generación.
3. Una Factory antigua o con generación vencida no publica código/checkpoint después de una nueva adquisición.
4. Caída antes y después de cada paso de publicación: remoto siempre coherente; timeout después de éxito se reconcilia sin duplicación.
5. Push rechazado conserva commits locales y no anuncia liberación ni continuación segura.
6. Nuevo host recupera etapa, aprobaciones, decisiones, preguntas y PR; no repite comentarios/comandos ya procesados.
7. Checkpoint periódico de ejecución larga con agente que escribe archivos: no captura mientras escribe ni aplica resultado incompleto.
8. Restricciones de QA/Reviewer y exclusión de secretos siguen vigentes en WIP, pausa y liberación.
9. Cambio externo no conflictivo en rama de trabajo o base: se conserva mediante merge y se repiten Test/Review cuando corresponde.
10. Conflicto, force push externo, borrado de rama o checkpoint inválido: bloqueo claro, sin pérdida de datos.
11. Pérdida de red, reloj desfasado, proceso suspendido/reanudado y daemon reiniciado: sin renovación por sesión vieja ni ejecución autorizada ilimitada.
12. Mantenimiento/update de una Factory no detiene issues de otras instalaciones.
13. Snapshot del dashboard muestra propiedad, workflow y checkpoint coherentes; no presenta un estado remoto antiguo como ejecución local.
14. Migración con instalación vieja aún activa es rechazada; exportación de workflows existentes conserva evidencias y ramas.
15. Eventos externos tardíos se detectan y no cambian el checkpoint autoritativo.
16. Un checkpoint de Factory seguido de commits humanos se recupera desde la punta integrada, conservando ambos trabajos y marcando verificaciones obsoletas.
17. Una rama/PR iniciada por un humano, sin checkpoint, se incorpora sin borrar código, inventar aprobaciones ni reiniciar toda la implementación.
18. Un humano publica durante la preparación de un checkpoint: CAS detecta la carrera y la reconciliación conserva su commit.
19. Dos issues intentan incorporar la misma rama: la asignación atómica permite solo uno, aunque las reservas por issue sean diferentes.

Estas pruebas pertenecen a desarrollo/CI. Instalación y Update mantienen validaciones locales de compatibilidad y arranque, sin ejecutar esta suite funcional en el entorno del usuario.

## 13. Orden de implementación propuesto

1. Validar protocolo, barrera de migración y formato portable con pruebas de carreras y fallos.
2. Implementar servicio de coordinación por issue y publicación atómica.
3. Implementar exportación/importación de contexto, checkpoints seguros y sincronización.
4. Integrar scheduler, runner, controles, GitHub, mantenimiento y cierre de procesos.
5. Incorporar UI/CLI por issue y migración de workflows existentes.
6. Retirar el controlador global solo cuando todos los caminos anteriores estén cubiertos.

Hasta completar el corte, no habilitar parcialmente un modo que quite la exclusividad global sin haber conectado las protecciones por issue.

## 14. Revisión solicitada

Clasificar cada observación como bloqueante, necesaria o mejora. Para cada una, describir una secuencia reproducible de fallo y la modificación propuesta.

Decisiones especialmente importantes:

- ¿El protocolo multi-ref es implementable en el remoto objetivo y protege también una publicación que llega tarde?
- ¿Cómo se manejan vencimiento, reloj desfasado y reaparición del propietario anterior?
- ¿La barrera de migración bloquea realmente versiones antiguas sin perder trabajo?
- ¿Los límites de ejecución para WIP son compatibles con adaptadores, política por rol y validación de HEAD actuales?
- ¿El formato portable conserva todo lo necesario para retomar sin copiar SQLite ni secretos?
- ¿Dónde queda el contexto después del merge del PR y qué impacto tiene en el diff de producto?
- ¿Qué acciones externas no pueden protegerse atómicamente y cómo se reconcilian?
- ¿Cómo se incorpora una rama/PR humana sin checkpoint y cómo se determina una etapa de continuación sin inventar aprobaciones?
- ¿Cómo se asigna una rama de forma exclusiva entre issues y se mantiene el PR existente, incluidas ramas fuera de `factory/`?

No aprobar solamente la arquitectura nominal: comprobar fallos parciales, concurrencia, efectos externos y recuperación de cada paso.
