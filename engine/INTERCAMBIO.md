# Aceptación/reclamo SII e intercambio entre contribuyentes

Implementado sobre la base c6c97dfe830524cd0b7fabfcbc8313421c88e9a2. Consulta de
fuentes: 2026-11-05/06. Las pruebas de esta entrega son offline y sintéticas; no
demuestran aceptación operacional del SII. No hay persistencia, correo,
custodia, decisiones automáticas del contribuyente ni reintentos.

## Cliente SOAP

Export: @ruraldte/engine/sii-reclamo. Cinco funciones con ambiente primero:
ingresarAceptacionReclamoDoc, listarEventosHistDoc, consultarFechaRecepcionSii,
consultarDocDteCedible y getVersion. Ambiente obligatorio: cert o prod. El
contrato es común a ambos ambientes; cambia el servidor de destino. La copia
verificable procede del endpoint de certificación. La descarga del WSDL
productivo devolvió cuerpo vacío durante la investigación; no se presenta esa
descarga como validación del servidor productivo.

El módulo reutiliza FetchFn y el token de getLegacyToken de sii-legacy. No usa
authenticate del canal REST de boletas ni crea una sesión del portal. El
consumidor entrega PFX/contraseña a getLegacyToken y token por cada llamada. No
hay caché nuevo ni renovación automática. getLegacyToken conserva su interfaz y
comportamiento originales; timeout y cancelación corresponden al cliente nuevo.

Ejemplo de llamada explícita (ejecutar solo con autorización del contribuyente):

```ts
import { getLegacyToken } from "@ruraldte/engine/sii-legacy";
import {
  ingresarAceptacionReclamoDoc,
  listarEventosHistDoc,
} from "@ruraldte/engine/sii-reclamo";

const token = await getLegacyToken("cert", pfxBytes, password);
const result = await ingresarAceptacionReclamoDoc("cert", {
  token,
  rutEmisor: "76543210-3",
  tipoDoc: 33,
  folio: "123",
  accionDoc: "ERM",
  signal,
});
// HTTP correcto no basta: comprobar data.codResp y su glosa.
const historial = await listarEventosHistDoc("cert", {
  token,
  rutEmisor: "76543210-3",
  tipoDoc: 33,
  folio: "123",
  signal,
});
```

Las cuatro operaciones documentales reciben rutEmisor completo, tipoDoc 33/34/43
y folio decimal positivo de hasta diez dígitos como string. El cliente separa
cuerpo (mínimo 1000, máximo ocho dígitos) y DV módulo 11, normalizando K
mayúscula. No se acepta 46: una factura 33/34 recibida de un proveedor no es una
Factura de Compra Electrónica tipo 46. getVersion no recibe documento y utiliza
token.

| Método                       | Parámetros SOAP                                | Retorno        |
| ---------------------------- | ---------------------------------------------- | -------------- |
| ingresarAceptacionReclamoDoc | rutEmisor, dvEmisor, tipoDoc, folio, accionDoc | respuestaTo    |
| listarEventosHistDoc         | rutEmisor, dvEmisor, tipoDoc, folio            | respuestaTo    |
| consultarFechaRecepcionSii   | rutEmisor, dvEmisor, tipoDoc, folio            | string literal |
| consultarDocDteCedible       | rutEmisor, dvEmisor, tipoDoc, folio            | respuestaTo    |
| getVersion                   | ninguno                                        | string literal |

SOAP 1.1 RPC/literal, namespace http://ws.registroreclamodte.diii.sdi.sii.cl,
SOAPAction vacío entre comillas, parámetros string sin namespace, UTF-8 y Cookie
TOKEN. El servicio de certificación usa ws2.sii.cl/WSREGISTRORECLAMODTECERT;
producción usa ws1.sii.cl/WSREGISTRORECLAMODTE; ambos terminan en
/registroreclamodteservice. No se envía a ?wsdl ni se firma el body SOAP.

Respuesta: status HTTP, raw redactado, data, parsing complete/partial y
observations. respuestaTo conserva codResp, descResp, rutToken y
listaEventosDoc; los campos son opcionales según el XSD. No se fabrican código
0/16 ni arreglos vacíos. Se conservan eventos nil, orden, repeticiones,
responsable, DV y fecha. NCA/ENC y eventos desconocidos no se reducen al último
evento. Las fechas del servicio se conservan como texto: WSDL no garantiza
formato ni zona.

RegistroReclamoError separa http, soap-fault, invalid-response, network, timeout
y aborted. Incluye operation, env, status cuando se conoce y outcome. El timeout
predeterminado es 30 segundos e incluye la lectura del cuerpo. signal cancela.
No se siguen redirecciones con credenciales. Los mensajes no incluyen el error
original del transporte ni el cuerpo de autenticación. No registrar raw sin la
política de protección de datos del consumidor; contiene información tributaria.

En escritura, outcome uncertain indica que no se puede descartar que el SII haya
registrado la acción, incluso tras HTTP/Fault o cuerpo ilegible. not-submitted
se usa cuando se cancela antes de invocar transporte. En consultas es
not-applicable. Nunca se reenvía automáticamente. Ante incertidumbre, consultar
historial y comparar acción, responsable y fecha; la ausencia inmediata no
prueba que no se registró. El consumidor decide cualquier reenvío. No hay
TrackID para este servicio.

## Acciones, autorización y RCV

ACD acepta contenido; ERM otorga recibo; RCD reclama contenido; RFP/RFT reclaman
falta parcial/total de mercaderías o servicios. El manual exige documentos
emitidos y recibidos desde 14-01-2017 y escrituras dentro de ocho días corridos
desde recepción SII. Permisos y plazo los decide el SII, no el reloj local.
Escribe el receptor/representante/usuario autorizado, excluyendo permiso solo de
consulta; emisor y tenedor autorizado pueden consultar según el servicio.

| Antecedente             | Solicitud             | Restricción oficial          |
| ----------------------- | --------------------- | ---------------------------- |
| Sin evento incompatible | Cualquiera            | Registrable dentro del plazo |
| ACD                     | ERM                   | Permitida                    |
| ERM                     | ACD                   | Permitida                    |
| ACD/ERM                 | Mismo evento          | Duplicado                    |
| ACD/ERM                 | Reclamo               | Incompatible                 |
| Reclamo                 | ACD/ERM               | Incompatible                 |
| Reclamo                 | Otro reclamo distinto | Permitida                    |
| Reclamo                 | Mismo reclamo         | Duplicado                    |

Códigos de escritura documentados: 0 correcto; 1 RUT; 2 folio; 3 tipo; 4 acción;
5 reclamado; 6 ERM incompatible; 7 duplicado; 8 plazo; 9 sin registros; 10
antigüedad; 11 reclamo tras ACD; 12 ACD tras reclamo; 13 reclamo tras ERM; 14
permiso emisor/receptor; 15 listado; 16 sin eventos; 17 permiso receptor; 18 no
recibido; 19 reclamo previo; -1 interno. Historial: 1/2/3/8/10/14/15/16/17/18.
Cedibilidad: 1/2/10/18, 20 tipo no cedible, 21 NC anulación, 22 sin registro, 23
cedible, 24 reclamado, 25 cedible por plazo. Fecha y versión no tienen código
funcional estructurado. Códigos nuevos se preservan, con observaciones; complete
solo describe parsing, no aceptación.

Separar evento SII, historial, sección/caracterización RCV y recepción física o
comercial del consumidor. ACD no sustituye ERM; ERM directo no exige ACD previo;
ACD seguido de ERM conserva ambos hechos. No se generan eventos tácitos ni ERM
por un temporizador. Este cliente no consulta ni modifica secciones del RCV. La
Circular 35/2017 distingue pago contado y exige el registro indicado por SII
para los efectos de crédito fiscal: generar un XML no prueba ese registro.

## Los tres XML

Esta sección describe solo el export optativo
@ruraldte/engine/intercambio-extendido. El export @ruraldte/engine/intercambio
mantiene su código, comentarios, tipos y defaults originales. Los builders del
módulo extendido devuelven xml Unicode con declaración ISO-8859-1 y bytes
Latin-1. Enviar bytes sin reformatearlos. Construir no envía al proveedor ni
registra ACD/ERM/reclamos ante el SII.

- buildRespuestaRecepcionEnvio: un envío; buildRespuestaRecepcionesEnvio: 1–1000
  envíos de las mismas partes. NroDetalles cuenta envíos; NroDTE cuenta el
  detalle. opts.detalles permite estado/glosa por documento, en el orden de
  entrada. Estados de envío: 0/1/2/3/90/91/99; de DTE: 0/1/2/3/4/99. Un
  destinatario diferente conserva la regla de estado 3. El rechazo ilegible
  puede carecer de documentos/digest; EnvioDTEID queda vacío cuando no se
  conoce, no se inventa.
- buildRespuestaResultadoDte: 1–1000 documentos, estados 0 aceptado, 1 con
  discrepancias, 2 rechazado. codRchDsc opcional, negativo de hasta tres
  dígitos. Glosas por estado; las respuestas técnicas y comerciales son
  modalidades excluyentes. No se convierten en eventos SOAP.
- buildEnvioRecibos: uno o más recibos; soporta 33/34/46/52. RutFirma procede
  del certificado; el override debe coincidir. Cada item puede indicar recinto,
  reciboId y tmstFirma. Firma DocumentoRecibo por documento y SetRecibos global.

Los campos agregados incluyen fonoContacto. Los límites son XSD: nombre 40,
correo 80, teléfono 40, nombre de archivo 80, glosas 256 y recinto 80. Los
nuevos builders rechazan largos inválidos; no truncan ni corrigen contenido
silenciosamente. Montos enteros CLP hasta 18 dígitos y folios hasta diez, con
strings para no perder precisión; number exige entero seguro. Estados e
identificadores inválidos fallan antes de entregar XML. Certificado y decisiones
son del consumidor. No se comprueba una facultad de firma tributaria offline.

parseInboundEnvioDteLossless usa DOM y namespaces y conserva cifras como
strings. parseInboundEnvioDte mantiene su retorno numérico histórico, pero
rechaza montos inseguros. Ambos extraen datos, sin validar XSD ni firmas.
Rechazan DTD/entidades, IDs duplicados, XML malformado y campos indispensables
ausentes. Antes de acusar conforme o emitir recibos, el consumidor debe validar
XSD y verificar el sobre y cada DTE con verifyInboundEnvio; su resultado no
acredita confianza completa CA. Un rechazo técnico puede construirse con
metadata explícita sin parsear un archivo ilegible. No se aceptan boletas o
documentos de exportación en estos builders.

Firma: C14N inclusiva 1.0 sin comentarios, RSA-SHA1 y SHA1; referencias #ID.
Resultado, DocumentoRecibo y SetRecibos se firman sobre su contexto final. La
corrección compartida selecciona el SignedInfo recién insertado, sin añadir
restricciones nuevas a los IDs o al objetivo del firmador histórico. Una firma
matemática no acredita vigencia, autorización SII ni cadena de confianza del
certificado.

Fechas/timestamps los entrega el consumidor: no se toma UTC y se elimina Z para
simular Santiago. Se conservan offsets y se valida el formato/calendario. Fuera
de Latin-1 y controles XML inválidos producen error antes de firmar.

### Separación de APIs

No se exige migración a consumidores de ./intercambio: conserva su
implementación original. Los controles y capacidades de esta sección se eligen
importando ./intercambio-extendido. Sus funciones homónimas no sustituyen las
originales. getLegacyToken tampoco cambia sus defaults ni sus excepciones.

La única corrección compartida de ejecución es seleccionar el SignedInfo de la
firma recién insertada. Esto cambia las firmas exteriores antes incorrectas; no
modifica ni reenvía documentos ya firmados. El manifest conserva 0.5.0 y las
nuevas capacidades se documentan como pendientes de publicación.

## Fuentes, esquemas y verificaciones

- [Manual reclamos V1.2, 07-08-2017](https://www.sii.cl/factura_electronica/Webservice_Registro_Reclamo_DTE_V1.2.pdf).
- [Autenticación V1.9, 18-11-2007](https://www.sii.cl/factura_electronica/factura_mercado/autenticacion.pdf).
- [WSDL](https://ws2.sii.cl/WSREGISTRORECLAMODTECERT/registroreclamodteservice?wsdl)
  y
  [XSD del servicio](https://ws2.sii.cl/WSREGISTRORECLAMODTECERT/registroreclamodteservice.xsd2.xsd).
- [schema_ic.zip](https://www.sii.cl/servicios_online/docs/xml/schema_ic.zip),
  [instructivo respuesta V1.0](https://www.sii.cl/servicios_online/docs/xml/formato_ic.pdf).
- [schema19983.zip](https://www.sii.cl/servicios_online/docs/xml/schema19983.zip),
  [instructivo recibo V1.0](https://www.sii.cl/servicios_online/docs/xml/desc_19983.pdf).
- [Circular 4/2017](https://www.sii.cl/normativa_legislacion/circulares/2017/circu4.pdf),
  [Circular 35/2017](https://www.sii.cl/normativa_legislacion/circulares/2017/circu35.pdf).

Los esquemas oficiales se aíslan en xsd/intercambio para no cambiar otras
familias. RespuestaEnvioDTE depende de SiiTypes y XMLDSig; EnvioRecibos incluye
Recibos, que depende de SiiTypes y XMLDSig. Se valida también Recibo standalone.
El instructivo incluye 43, pero DocType/DTEType publicados lo excluyen: no se
modifica el XSD ni se promete conformidad para 43 en el módulo extendido. Esta
restricción no se aplica al export histórico ni a la generación de DTE 43. El
recibo no declara soporte 56/61 aunque el XSD los admite, porque el instructivo
no respalda ese uso. Correo/IdRespuesta difieren entre PDF y XSD: se respeta el
XSD (80/positivo). EnvioDTEID usa el ID del SetDTE referenciado por la firma
original; el PDF tiene una descripción ambigua. El digest es el original, no uno
de XML reformateado.

Las copias SOAP y manifest de fuentes están en xsd/registro-reclamo; los SHA-256
permiten detectar cambios. El paquete incluye estas copias oficiales y su
manifiesto de procedencia. Devlas fue referencia secundaria, SHA
55265bde1f0c0ea6f27dc0faec7d07b778ac08bd, MIT, archivado/deprecado. No se copia
código ni incorpora dependencia. Se descartan resumen por último evento,
defaults fabricados y reintentos de escritura de WsReclamo.js.

Con xmllint en PATH, ejecutar deno task check y deno task test. También:

```powershell
$env:XMLLINT = "C:/Users/vbast/source/repos/vcpkg/installed/x64-windows/tools/libxml2/xmllint.exe"
deno task test:intercambio:conformance
# Para toda la suite, agregar también el directorio de xmllint al PATH del proceso.
$env:PATH = (Split-Path $env:XMLLINT) + ";" + $env:PATH
$env:XSD_REQUIRED = "1"
deno task test
```

La suite nueva falla si falta xmllint: no omite XSD ni firma. Verifica todos los
digests con C14N de libxml2 y todas las firmas RSA con node:crypto,
independientes de C14N/forge del motor. No exige xmlsec1 ni añade dependencia de
ejecución. Incluye mutaciones negativas, namespaces, ambos destinos SOAP y
credenciales sintéticas. Las pruebas adicionales están en tests/intercambio/ y
no se cargan desde la tarea histórica que recorre engine/. Los workflows
originales permanecen intactos. Ejecutar la tarea explícita de conformidad antes
de dar por verificada la ampliación. Verificar empaquetado con deno publish
--dry-run, sin publicar ni crear tags automáticamente.

La validación real en certificación queda separada: requiere autorización y
material apropiado; probar versión, consultas, ERM directo, ACD→ERM, cada
reclamo, duplicados e incompatibilidades en documentos distintos y releer
historial. Registrar evidencia sanitizada y diferencias; no extrapolar fixtures
como aceptación del SII. No se ejecuta ninguna transacción real en esta entrega.

CONTRIBUTING exige DCO y sincronización del espejo generado con el canónico. Una
contribución upstream debe trasladarse al canónico y conservar exportación, SPDX
y avisos SII. No se publica en el paquete upstream sin su canal autorizado. API
DTE deberá adoptar un SHA inmutable y adaptar HTTP en una tarea separada;
negocio decide acciones, permisos, persistencia, auditoría y reconciliación. No
se cambian contratos ni repositorios consumidores aquí.
