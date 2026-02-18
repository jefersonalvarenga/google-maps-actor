#!/usr/bin/env python3
"""
Envia os dados extraídos pelo google-maps-actor para o webhook do n8n (array único).

Uso:
    python3 send_to_webhook.py <search_run_id>
    python3 send_to_webhook.py f6aa3c1c-78b7-47ff-a334-e6e93ceb3da5
"""

import sys
import json
import urllib.request
import urllib.error
from pathlib import Path

WEBHOOK_URL = "https://n8n.easyscale.co/webhook/88f6ef19-a991-49c3-bd58-f25fbd36b7b3"
API_KEY     = "f331be59edea8170a3581c01fa6d771da6775806ff2d844ffa62d33369c356e8"


def send(payload: list) -> tuple:
    """Envia array de registros para o webhook. Retorna (ok, status_code, body)."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        WEBHOOK_URL,
        data=data,
        headers={
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return True, resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return False, e.code, e.read().decode("utf-8")
    except urllib.error.URLError as e:
        return False, 0, str(e.reason)


def main():
    if len(sys.argv) < 2:
        print("Uso: python3 send_to_webhook.py <search_run_id>")
        print("Ex:  python3 send_to_webhook.py f6aa3c1c-78b7-47ff-a334-e6e93ceb3da5")
        sys.exit(1)

    search_run_id = sys.argv[1]
    dataset_dir = Path("storage/datasets") / search_run_id

    if not dataset_dir.exists():
        dataset_dir = Path("storage/datasets/default")
        if not dataset_dir.exists():
            print(f"❌ Pasta não encontrada: storage/datasets/{search_run_id}")
            sys.exit(1)
        print(f"⚠️  Usando dataset padrão: {dataset_dir}")
    else:
        print(f"📂 Dataset: {dataset_dir}")

    # Carrega todos os .json exceto retry_queue.json
    files = sorted(f for f in dataset_dir.glob("*.json") if f.name != "retry_queue.json")
    if not files:
        print("❌ Nenhum arquivo .json encontrado no dataset.")
        sys.exit(1)

    # Carrega todos os registros
    records = []
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            # Cada arquivo pode ser um registro único ou uma lista
            if isinstance(data, list):
                for record in data:
                    record["search_run_id"] = search_run_id
                    records.append(record)
            else:
                data["search_run_id"] = search_run_id
                records.append(data)
        except Exception as e:
            print(f"⚠️  Erro ao ler {f.name}: {e}")

    size_kb = len(json.dumps(records).encode("utf-8")) / 1024
    print(f"📦 {len(records)} registro(s) | {size_kb:.1f} KB → enviando em uma requisição...")

    ok, status, body = send(records)

    if ok:
        print(f"✅ Enviado com sucesso! HTTP {status}")
    else:
        print(f"❌ Erro HTTP {status}: {body[:300]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
