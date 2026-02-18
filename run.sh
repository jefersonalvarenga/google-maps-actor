#!/bin/bash
# Roda o google-maps-actor para um run específico gerado pelo prepare_input.py
#
# Uso:
#   ./run.sh <search_run_id>    ← roda com inputs/<search_run_id>/INPUT.json
#   ./run.sh                    ← roda com o input padrão

set -e

if [ -n "$1" ]; then
    export RUN_ID="$1"
    INPUT_PATH="inputs/$RUN_ID/INPUT.json"

    if [ ! -f "$INPUT_PATH" ]; then
        echo "❌ Input não encontrado: $INPUT_PATH"
        echo "   Gere primeiro com: python3 prepare_input.py $RUN_ID"
        exit 1
    fi

    echo "🚀 Iniciando scraper com RUN_ID: $RUN_ID"
    echo "   Input:   $INPUT_PATH"
    echo "   Dataset: storage/datasets/$RUN_ID/"
else
    echo "🚀 Iniciando scraper com input padrão"
    echo "   Input:   storage/key_value_stores/default/INPUT.json"
    echo "   Dataset: storage/datasets/default/"
fi

apify run
