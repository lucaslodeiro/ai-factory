# Solicitud de revisión independiente

> Revisión diferida: la propuesta asociada no es el alcance vigente. Por ahora se elimina el controlador global y se asume una sola Factory por repositorio.

Revisá `docs/ISSUE_OWNERSHIP_AND_RECOVERY_SPEC.md` contra el código actual de AI Factory. Es una propuesta; no está implementada. No modifiques código ni publiques mensajes, commits o PR durante esta revisión.

El objetivo acordado es reemplazar el takeover global por exclusividad por issue, liberación explícita, contexto portable en Git, commits/push parciales y sincronización mediante merge con cambios externos. Debe retomar trabajo de otra Factory, commits humanos posteriores al checkpoint e implementaciones humanas sin checkpoint previo, sin borrar avances ni reiniciar por defecto.

Inspeccioná especialmente:

- `src/controller-lease.ts`, `src/controller-fence.ts`, `src/controller-runtime.ts` y `src/daemon.ts`.
- `src/workflow-orchestrator.ts`, `src/workflow-runner.ts`, `src/workflow-scheduler.ts` y `src/workflow-controls.ts`.
- `src/worktrees.ts`, contratos de agentes y políticas de verificación.
- `src/storage.ts`, registros, proyecciones, ensamblado de contexto y resultados.
- Publicaciones GitHub, notificaciones, dashboard, CLI, mantenimiento y actualización.

Buscá contraejemplos concretos: dos propietarios, push tardío del propietario anterior, caída entre escrituras, liberación sin checkpoint, commits mientras un agente escribe, contexto incompleto, doble procesamiento de comentarios, validaciones obsoletas tras merge y convivencia con versiones antiguas. Validá también una rama humana sin metadatos, un checkpoint desactualizado por commits humanos y dos issues intentando escribir en la misma rama.

Entregá:

1. Veredicto: lista para implementar / requiere cambios.
2. Hallazgos por severidad, con escenario reproducible, referencia precisa y solución propuesta.
3. Respuestas a las decisiones abiertas de la sección 14.
4. Ajustes al esquema portable y al protocolo de escritura/recuperación.
5. Matriz de pruebas faltantes y orden de implementación recomendado.

Diferenciá requisitos acordados de mecanismos propuestos. No reduzcas el alcance a un lock por issue: sin progreso y contexto publicados no se cumple la transferencia entre máquinas. No afirmes fencing absoluto de APIs de GitHub basándote únicamente en una comprobación local anterior a la llamada.
