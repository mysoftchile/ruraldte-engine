# RCV: exportación inmediata de CSV

`./sii-rcv` publica `exportRcvCsv(input, options?)`. Recibe empresaRut, periodo
AAAAMM, operacion COMPRA/VENTA, exportacion resumen/detalle y autenticacion:
`{ tipo: "clave", rut, clave }` o `{ tipo: "certificado", pfxPassword }` con
`pfx: Uint8Array`. Solo producción. Las credenciales deben pertenecer a un
usuario autorizado para consultar la empresa.

Devuelve `{ sinDatos: true }` solo ante respuesta explícita sin archivo, o
`{ sinDatos: false, bytes, nombreArchivo, contentType }`. Los archivos conservan
bytes y charset; las líneas de JSON se concatenan con LF final y UTF-8, como el
portal. No normaliza columnas, montos, fechas ni agrega BOM. El adaptador HTTP
debe sanear el nombre al construir Content-Disposition.

Cada operación abre un cliente y cookies propios, autentica, inicializa el
portal y exporta globalmente. Compras usa REGISTRO. El resumen RV usa REGISTRO y
el detalle RV estado vacío; detalle usa codTipoDoc 0. No consulta resúmenes
previos ni combina tipos documentales. No envía campos de reCAPTCHA ni
automatiza desafíos.

En finally solicita logout, comprueba que Mi SII rechace las cookies previas y
cierra el cliente TLS. El cierre usa plazos independientes de la cancelación de
la consulta. No persiste sesiones ni registra cuerpos. No hay reintentos.

Errores seguros RcvCsvError.code: SII_OPERATION_FAILED, SII_TIMEOUT,
SII_RCV_DEFERRED_REQUIRED y SII_SESSION_CLOSE_FAILED. Un fallo de cierre
descarta el CSV; si ya había un error, conserva el error principal. Una
respuesta diferida o gzip se rechaza sin llamar a servicios de control o
descargar el archivo.

Límites: 30 segundos para la consulta, hasta 5 segundos por paso de cierre, 32
MiB por respuesta y seis saltos de redirección como máximo. Solo acepta HTTPS en
los hosts SII usados. fetchFn y createClient permiten pruebas offline; no
inyectar transportes no confiables en producción.

`deno task test:rcv` verifica las cuatro exportaciones, ambas autenticaciones,
conservación de bytes, errores, logout y cancelación con respuestas simuladas.
No usa credenciales ni datos reales. La cuenta inspeccionada confirmó RC en
junio 2026, pero no la descarga automatizada de este módulo. Certificado, RV y
el flujo HTTP completo permanecen pendientes de comprobación real. La respuesta
1 de exportación se trata como descarga diferida; otras respuestas desconocidas
fallan sin inventar CSV. El SII puede cambiar su interfaz interna sin aviso.
