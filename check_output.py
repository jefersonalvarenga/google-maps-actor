#!/usr/bin/env python3
"""
Verifica a qualidade dos dados extraídos pelo google-maps-actor.
Lê os arquivos JSON do dataset local e gera um relatório.

Uso:
    python check_output.py                                      # dataset padrão
    python check_output.py <run_id>                             # storage/datasets/<run_id>/
    python check_output.py dados.json                           # arquivo único exportado do Apify
    python check_output.py storage/datasets/<run_id>            # caminho completo
"""

import json
import re
import sys
from pathlib import Path
from collections import defaultdict

# ─── Configuração ────────────────────────────────────────────────────────────

DATASET_DIR = Path("storage/datasets/default")

FIELDS = [
    "name", "rating", "reviews_count", "phone", "website", "whatsapp",
    "full_address", "street", "city", "state", "postal_code", "country_code",
    "latitude", "longitude", "place_id", "cid", "knowledge_graph_id",
    "category_primary", "business_status", "price_level",
    "google_maps_url", "search_term", "location", "scraped_at",
]

# Campos que esperamos ter valor na maioria dos registros
IMPORTANT_FIELDS = ["name", "rating", "reviews_count", "phone", "website",
                    "full_address", "latitude", "longitude", "category_primary"]

# ─── Carregamento ────────────────────────────────────────────────────────────

def load_records(source: Path) -> list[dict]:
    records = []
    if source.is_dir():
        files = sorted(source.glob("*.json"))
        if not files:
            print(f"⚠️  Nenhum arquivo .json encontrado em {source}")
            sys.exit(1)
        for f in files:
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if isinstance(data, list):
                    records.extend(data)
                else:
                    records.append(data)
            except json.JSONDecodeError as e:
                print(f"⚠️  Erro ao ler {f.name}: {e}")
    elif source.is_file():
        data = json.loads(source.read_text(encoding="utf-8"))
        records = data if isinstance(data, list) else [data]
    else:
        print(f"❌ Caminho não encontrado: {source}")
        sys.exit(1)
    return records

# ─── Validações ──────────────────────────────────────────────────────────────

def check_record(r: dict) -> list[str]:
    issues = []

    # Nome inválido
    name = r.get("name")
    if not name:
        issues.append("name vazio")
    elif name == "Google Maps":
        issues.append("name='Google Maps' (captura inválida)")

    # Rating fora do range
    rating = r.get("rating")
    if rating is not None and not (1.0 <= rating <= 5.0):
        issues.append(f"rating fora do range (1-5): {rating}")

    # reviews_count com rating presente mas count nulo
    if rating is not None and r.get("reviews_count") is None:
        issues.append("rating presente mas reviews_count=null")

    # reviews_count sem rating
    if r.get("reviews_count") is not None and rating is None:
        issues.append("reviews_count presente mas rating=null")

    # Telefone — validar E.164 BR (+55 + 10 ou 11 dígitos)
    phone = r.get("phone")
    if phone and not re.match(r'^\+55\d{10,11}$', phone):
        issues.append(f"phone fora do E.164 BR: {phone!r}")

    # Website sem protocolo
    website = r.get("website")
    if website and not website.startswith(("http://", "https://")):
        issues.append(f"website sem protocolo: {website!r}")

    # Coordenadas — uma presente sem a outra
    lat, lng = r.get("latitude"), r.get("longitude")
    if (lat is None) != (lng is None):
        issues.append(f"coordenadas incompletas: lat={lat}, lng={lng}")

    # Coordenadas fora do Brasil (aproximado)
    if lat is not None and lng is not None:
        if not (-35 <= lat <= 5 and -75 <= lng <= -30):
            issues.append(f"coordenadas fora do Brasil: ({lat}, {lng})")

    # CEP formato BR
    postal_code = r.get("postal_code")
    if postal_code and not re.match(r'^\d{5}-\d{3}$', postal_code):
        issues.append(f"postal_code fora do padrão XXXXX-XXX: {postal_code!r}")

    # Caracteres invisíveis remanescentes
    full_address = r.get("full_address") or ""
    if re.search(r'[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]', full_address):
        issues.append("full_address ainda contém caracteres Unicode invisíveis")

    # URL do Maps
    url = r.get("google_maps_url") or ""
    if url and "google.com/maps" not in url:
        issues.append(f"google_maps_url suspeita: {url[:80]!r}")

    return issues

# ─── Relatório ───────────────────────────────────────────────────────────────

def pct(n, total):
    return f"{n/total*100:.1f}%" if total else "n/a"

def run(source: Path):
    records = load_records(source)
    total = len(records)

    if total == 0:
        print("⚠️  Nenhum registro encontrado.")
        return

    print(f"\n{'═'*60}")
    print(f"  📊 Relatório de qualidade — {total} registros")
    print(f"{'═'*60}\n")

    # ── Preenchimento por campo ───────────────────────────────────────────────
    print("PREENCHIMENTO POR CAMPO")
    print(f"  {'Campo':<22} {'Preenchido':>10}  {'%':>6}  {'Nulo':>6}")
    print(f"  {'-'*22}  {'-'*10}  {'-'*6}  {'-'*6}")

    for field in FIELDS:
        filled = sum(1 for r in records if r.get(field) not in (None, "", [], {}))
        null = total - filled
        marker = " ⚠️ " if field in IMPORTANT_FIELDS and filled / total < 0.5 else ""
        print(f"  {field:<22} {filled:>10}  {pct(filled, total):>6}  {null:>6}{marker}")

    # ── Problemas por registro ────────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print("PROBLEMAS ENCONTRADOS")

    all_issues = defaultdict(int)
    problem_records = []

    for r in records:
        issues = check_record(r)
        for issue in issues:
            all_issues[issue] += 1
        if issues:
            problem_records.append((r.get("name", "?"), r.get("google_maps_url", "")[:60], issues))

    if not all_issues:
        print("  ✅ Nenhum problema encontrado!")
    else:
        print(f"  {'Problema':<50} {'Qtd':>5}")
        print(f"  {'-'*50}  {'-'*5}")
        for issue, count in sorted(all_issues.items(), key=lambda x: -x[1]):
            print(f"  {issue:<50} {count:>5}  ({pct(count, total)})")

    # ── Distribuição por search_term ──────────────────────────────────────────
    print(f"\n{'─'*60}")
    print("REGISTROS POR SEARCH TERM")
    terms = defaultdict(int)
    for r in records:
        terms[r.get("search_term", "(sem termo)")] += 1
    for term, count in sorted(terms.items(), key=lambda x: -x[1]):
        print(f"  {term:<40} {count:>5}")

    # ── Registros problemáticos (primeiros 10) ────────────────────────────────
    if problem_records:
        print(f"\n{'─'*60}")
        print(f"EXEMPLOS DE REGISTROS COM PROBLEMAS (primeiros 10 de {len(problem_records)})")
        for name, url, issues in problem_records[:10]:
            print(f"\n  📍 {name}")
            if url:
                print(f"     {url}")
            for issue in issues:
                print(f"     ❌ {issue}")

    # ── Resumo final ──────────────────────────────────────────────────────────
    print(f"\n{'═'*60}")
    clean = total - len(problem_records)
    print(f"  ✅ Registros sem problemas: {clean}/{total} ({pct(clean, total)})")
    print(f"  ⚠️  Registros com problemas: {len(problem_records)}/{total} ({pct(len(problem_records), total)})")
    print(f"{'═'*60}\n")


# ─── Entry point ─────────────────────────────────────────────────────────────

def resolve_source(arg: str) -> Path:
    p = Path(arg)
    # Caminho completo ou arquivo — usa direto
    if p.exists():
        return p
    # Parece um run_id (sem separador de pasta) → monta o caminho
    if "/" not in arg and "\\" not in arg:
        candidate = Path("storage/datasets") / arg
        if candidate.exists():
            return candidate
        print(f"❌ Dataset não encontrado: {candidate}")
        print(f"   Rode primeiro: ./run.sh {arg}")
        sys.exit(1)
    print(f"❌ Caminho não encontrado: {p}")
    sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        source = resolve_source(sys.argv[1])
    else:
        source = DATASET_DIR

    run(source)
