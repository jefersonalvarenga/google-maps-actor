#!/usr/bin/env python3
"""
prepare_input.py
────────────────
Gera o INPUT.json para o google-maps-actor a partir de um arquivo de configuração.

Uso:
    python3 prepare_input.py <search_run_id>

Exemplo:
    python3 prepare_input.py f6aa3c1c-78b7-47ff-a334-e6e93ceb3da5

Espera encontrar:
    datasets/<search_run_id>.json   ← configuração do run (searchTerms, location, etc.)

Gera:
    inputs/<search_run_id>/INPUT.json
    inputs/<search_run_id>/manifest.json

Formato do dataset de entrada (datasets/<search_run_id>.json):
    {
        "searchTerms": ["clínica estética", "dermatologista"],
        "location": "São Paulo, SP, BR",
        "maxCrawledPlacesPerSearch": 100,
        "language": "pt-BR",
        "onlyWithWebsite": true,
        "userData": { "campaign_id": "camp_001" }
    }
"""

import json
import sys
import argparse
from datetime import datetime
from pathlib import Path

# ─── Config ──────────────────────────────────────────────────────────────────

BASE_DIR     = Path(__file__).parent
DATASETS_DIR = BASE_DIR / "datasets"
INPUTS_DIR   = BASE_DIR / "inputs"

DEFAULTS = {
    "maxCrawledPlacesPerSearch": 100,
    "language":                  "pt-BR",
    "onlyWithWebsite":           False,
    "concurrency":               3,
    "userData":                  {},
}

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Gera INPUT.json para o google-maps-actor'
    )
    parser.add_argument(
        'search_run_id',
        help='ID do run (ex: f6aa3c1c-78b7-47ff-a334-e6e93ceb3da5)'
    )
    args = parser.parse_args()

    search_run_id = args.search_run_id
    dataset_path  = DATASETS_DIR / f"{search_run_id}.json"

    print("\n" + "═" * 60)
    print("  GOOGLE MAPS ACTOR  |  prepare_input")
    print("═" * 60)

    # ── 1. Lê dataset de configuração ────────────────────────────────────────
    if not dataset_path.exists():
        print(f"\n❌ Dataset não encontrado: {dataset_path}")
        print(f"\n   Crie o arquivo com a configuração do run:")
        print(f"   datasets/{search_run_id}.json")
        print(f"\n   Formato esperado:")
        print(json.dumps({
            "searchTerms": ["clínica estética", "dermatologista"],
            "location": "São Paulo, SP, BR",
            "maxCrawledPlacesPerSearch": 100,
            "language": "pt-BR",
            "onlyWithWebsite": True,
            "userData": {"campaign_id": "exemplo"}
        }, ensure_ascii=False, indent=4))
        sys.exit(1)

    print(f"\n📂 Dataset: {dataset_path}")

    try:
        with open(dataset_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except json.JSONDecodeError as e:
        print(f"❌ JSON inválido: {e}")
        sys.exit(1)

    # ── 2. Valida campos obrigatórios ─────────────────────────────────────────
    if not config.get('searchTerms'):
        print("❌ Campo obrigatório ausente: searchTerms")
        sys.exit(1)
    if not config.get('location'):
        print("❌ Campo obrigatório ausente: location")
        sys.exit(1)

    search_terms = config['searchTerms']
    if not isinstance(search_terms, list) or len(search_terms) == 0:
        print("❌ searchTerms deve ser uma lista não vazia")
        sys.exit(1)

    # ── 3. Monta INPUT.json ───────────────────────────────────────────────────
    input_data = {
        **DEFAULTS,
        **{k: v for k, v in config.items()},   # config sobrescreve defaults
        "userData": {
            **DEFAULTS["userData"],
            **(config.get("userData") or {}),
            "search_run_id": search_run_id,     # sempre injeta o search_run_id no userData
        }
    }

    # ── 4. Salva arquivos ─────────────────────────────────────────────────────
    out_dir = INPUTS_DIR / search_run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    input_path    = out_dir / "INPUT.json"
    manifest_path = out_dir / "manifest.json"

    with open(input_path, 'w', encoding='utf-8') as f:
        json.dump(input_data, f, ensure_ascii=False, indent=4)

    max_per_search = input_data.get('maxCrawledPlacesPerSearch', 100)
    total_est      = len(search_terms) * max_per_search
    time_est_min   = total_est * 0.65 / 60  # ~650ms por lugar

    manifest = {
        "searchRunId": search_run_id,
        "createdAt":   datetime.now().isoformat(),
        "source":      str(dataset_path.resolve()),
        "stats": {
            "searchTerms":              len(search_terms),
            "maxCrawledPerSearch":      max_per_search,
            "estimatedTotalPlaces":     total_est,
            "estimatedTimeMinutes":     round(time_est_min),
        },
        "input": input_data,
    }

    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=4)

    # ── 5. Resumo ─────────────────────────────────────────────────────────────
    print(f"\n   Termos de busca:  {len(search_terms)}")
    print(f"   Localização:      {input_data['location']}")
    print(f"   Máx. por busca:   {max_per_search}")
    print(f"   Apenas c/ site:   {input_data.get('onlyWithWebsite', False)}")
    print(f"   Lugares est.:     ~{total_est}")
    print(f"   Tempo est.:       ~{time_est_min:.0f} min")

    print("\n" + "─" * 60)
    print("✅ PRONTO!")
    print("─" * 60)
    print(f"\n   INPUT.json:  {input_path}")
    print(f"   manifest:    {manifest_path}")
    print(f"\n🚀 Para rodar:\n")
    print(f"   ./run.sh {search_run_id}")
    print("\n" + "═" * 60 + "\n")


if __name__ == '__main__':
    main()
