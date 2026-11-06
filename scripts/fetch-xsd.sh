#!/usr/bin/env bash
# ============================================================================
# fetch-xsd.sh — baja los esquemas XSD desde el SII, que es de donde son.
# ----------------------------------------------------------------------------
# Deja DOS cosas:
#
#   .sii-xsd/            el kit COMPLETO con la estructura que publica el SII
#                        (schema_dte/, schema_iecv/, …). Es lo que necesita
#                        `deno task cert:xsd .sii-xsd`. Está en .gitignore.
#
#   engine/xsd/*.xsd     los pocos esquemas que cargan los tests, en plano.
#                        Ya vienen versionados; esto los REFRESCA desde la
#                        fuente si quieres verificar que son los mismos.
#
# Los .xsd son del Servicio de Impuestos Internos, no nuestros: los incluimos
# por comodidad y NO están cubiertos por la licencia de este repo (ver NOTICE).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="https://www.sii.cl/factura_electronica/factura_mercado"
KIT=".sii-xsd"
# schema_lgd = Libro de Guías de Despacho. Faltaba, y sin él
# `deno task cert:xsd .sii-xsd` terminaba en ❌ por LibroGuia_v10.xsd — el flujo
# que documenta el README no llegaba a puerto.
ZIPS=(schema_dte schema_iecv schema_envio_bol schema_libro_bol schema_lgd)

mkdir -p "$KIT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

for z in "${ZIPS[@]}"; do
  echo "→ $z.zip"
  curl -fsSL "$BASE/$z.zip" -o "$TMP/$z.zip"
  rm -rf "${KIT:?}/$z"
  unzip -oq "$TMP/$z.zip" -d "$KIT/$z"
done

echo
echo "Kit completo en $KIT/ — úsalo así:"
echo "    deno task cert:xsd $KIT"
echo

# Refresco de los esquemas versionados (solo los que ya existen: no agregamos
# archivos nuevos al repo sin que alguien lo decida).
cambios=0
for f in engine/xsd/*.xsd; do
  nuevo="$(find "$KIT" -name "$(basename "$f")" -print -quit)"
  if [ -n "$nuevo" ] && ! cmp -s "$nuevo" "$f"; then
    cp "$nuevo" "$f"; echo "  actualizado: $f"; cambios=$((cambios+1))
  fi
done
[ "$cambios" -eq 0 ] && echo "engine/xsd/: idénticos a la fuente del SII ✓"


# Intercambio: dependencias aisladas para no sustituir los tipos de otras familias.
# Fijadas a los ZIP oficiales revisados; un cambio remoto exige revisar el manifest.
mkdir -p engine/xsd/intercambio
for z in schema_ic schema19983; do
  curl -fsSL "https://www.sii.cl/servicios_online/docs/xml/$z.zip" -o "$TMP/$z.zip"
  case "$z" in
    schema_ic) esperado=a97ec9160341b276b5fe07330de72779d90d3d514fd33b40ba4028dc9e0f3f0f ;;
    schema19983) esperado=61b9e7753fa14df95d094467942964aeb9f55e963429d03cad082fc07f22f577 ;;
  esac
  printf '%s  %s\n' "$esperado" "$TMP/$z.zip" | sha256sum -c -
  unzip -oq "$TMP/$z.zip" -d "$TMP/$z"
done
for nombre in RespuestaEnvioDTE_v10.xsd Recibos_v10.xsd EnvioRecibos_v10.xsd SiiTypes_v10.xsd xmldsignature_v10.xsd; do
  fuente="$TMP/schema19983/$nombre"
  [ "$nombre" = RespuestaEnvioDTE_v10.xsd ] && fuente="$TMP/schema_ic/$nombre"
  cp "$fuente" "engine/xsd/intercambio/$nombre"
done
