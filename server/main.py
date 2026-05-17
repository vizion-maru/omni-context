from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sentence_transformers import SentenceTransformer
import chromadb
import hashlib
import subprocess
import re
import math

app = FastAPI(title="Omni-Context")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

chroma_client = chromadb.PersistentClient(path="./chroma_data")
collection = chroma_client.get_or_create_collection(name="omni_context")
model = SentenceTransformer("all-MiniLM-L6-v2")
_model_loaded = True

MIN_CONTENT_LEN = 10
MAX_RESULTS = 7
MIN_SCORE = 0.25

_FALLBACK_URL_PATTERNS = re.compile(
    r"(telegram\.org|web\.whatsapp|chatgpt\.com|claude\.ai|codex\.|gemini\.)", re.I
)

_REASON_THRESHOLDS = [
    (0.55, "Starke semantische Übereinstimmung"),
    (0.40, "Thematisch verwandt"),
    (0.25, "Schwache Verbindung"),
]


def _make_tab_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:12]


def _normalize_content(raw: str) -> str:
    if not raw:
        return ""
    return re.sub(r"\s+", " ", raw).strip()


def _normalize_embedding(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return vec
    return [v / norm for v in vec]


def _l2_dist_to_score(dist: float) -> float:
    """For L2-normalized unit vectors: cosine_sim = 1 - dist²/2."""
    return max(0.0, min(1.0, 1.0 - (dist * dist) / 2.0))


def _extract_snippet(doc: str, max_len: int = 200) -> str:
    if not doc:
        return ""
    if doc.startswith("[SHORT] "):
        doc = doc[8:]
    if len(doc) > max_len:
        snippet = doc[:max_len]
        cut = snippet.rfind(" ")
        return (snippet[:cut] if cut > max_len * 0.6 else snippet) + "..."
    return doc


def _infer_source_quality(content: str, url: str, is_fallback_flag) -> str:
    if is_fallback_flag:
        return "fallback"
    if _FALLBACK_URL_PATTERNS.search(url):
        return "fallback"
    text_only = re.sub(r"\s+", "", content)
    if len(text_only) < 50:
        return "fallback"
    return "content"


def _assign_reason(score: float, quality: str) -> str:
    if quality == "fallback":
        return "Nur Titel/URL verfügbar"
    for threshold, label in _REASON_THRESHOLDS:
        if score >= threshold:
            return label
    return "Schwache Verbindung"


def _is_camel_body(body: dict) -> bool:
    return "currentTitle" in body or "currentUrl" in body or "results" in body


@app.get("/status")
def status():
    if collection.count() == 0:
        return {"indexed_tabs": 0, "model_loaded": _model_loaded}
    all_meta = collection.get(include=["metadatas"])["metadatas"]
    tab_ids = set(m.get("tab_id") for m in all_meta if m.get("tab_id"))
    return {
        "indexed_tabs": len(tab_ids),
        "model_loaded": _model_loaded,
    }


@app.post("/index")
def index_item(body: dict):
    tab_id = body.get("tab_id")
    title = body.get("title", "")
    url = body.get("url", "")
    is_fallback_flag = body.get("isFallback") or body.get("is_fallback") or False
    content = _normalize_content(body.get("content") or body.get("text") or "")

    if not content:
        return {"status": "skipped", "reason": "empty_content"}

    if not tab_id:
        tab_id = _make_tab_id(url) if url else _make_tab_id(title)
    tab_id = str(tab_id)

    doc_id = f"{tab_id}:{url}"

    existing = collection.get(
        where={"tab_id": tab_id},
        include=["metadatas"],
    )
    for idx, meta in enumerate(existing["metadatas"]):
        if meta.get("url") == url:
            collection.delete(ids=[existing["ids"][idx]])

    source_quality = _infer_source_quality(content, url, is_fallback_flag)

    if len(content) < MIN_CONTENT_LEN:
        content = f"[SHORT] {content}"

    raw_embedding = model.encode(content).tolist()
    embedding = _normalize_embedding(raw_embedding)

    collection.upsert(
        ids=[doc_id],
        embeddings=[embedding],
        metadatas=[
            {
                "tab_id": tab_id,
                "title": title,
                "url": url,
                "source_quality": source_quality,
                "content_len": len(content),
            }
        ],
        documents=[content],
    )
    return {"status": "ok", "id": doc_id, "source_quality": source_quality}


@app.post("/query")
def query_item(body: dict):
    tab_id = body.get("tab_id")
    url = body.get("url", "")
    content = _normalize_content(body.get("content") or body.get("text") or "")

    if not tab_id:
        tab_id = _make_tab_id(url) if url else None

    if not content:
        return []

    if len(content) < MIN_CONTENT_LEN:
        content = f"[SHORT] {content}"

    raw_embedding = model.encode(content).tolist()
    embedding = _normalize_embedding(raw_embedding)

    total = collection.count()
    if total == 0:
        return []

    where_clause = {"tab_id": {"$ne": tab_id}} if tab_id else None

    results = collection.query(
        query_embeddings=[embedding],
        n_results=min(total, 100),
        where=where_clause,
        include=["metadatas", "documents", "distances"],
    )

    output = []
    ids = results["ids"][0] if results["ids"] else []
    for i in range(len(ids)):
        dist = results["distances"][0][i]
        score = _l2_dist_to_score(dist)

        if score < MIN_SCORE:
            continue

        meta = results["metadatas"][0][i]
        doc = results["documents"][0][i]
        quality = meta.get("source_quality", "content")
        reason = _assign_reason(score, quality)

        output.append(
            {
                "tab_id": meta.get("tab_id", ""),
                "title": meta.get("title", ""),
                "url": meta.get("url", ""),
                "snippet": _extract_snippet(doc),
                "score": round(score, 4),
                "distance": round(dist, 4),
                "source_quality": quality,
                "reason": reason,
            }
        )

        if len(output) >= MAX_RESULTS:
            break

    return output


@app.post("/summarize")
def summarize(body: dict):
    if _is_camel_body(body):
        current_title = body.get("currentTitle", "")
        current_content = _normalize_content(body.get("currentContent", ""))[:500]
        related = body.get("results", [])
    else:
        current_title = body.get("current_title", "")
        current_content = _normalize_content(
            body.get("current_content") or body.get("content", "")
        )[:500]
        related = body.get("related", [])

    if not related:
        related = body.get("results", [])

    if not related:
        return {"summary": "Keine Verbindungen gefunden."}

    context_parts = []
    for r in related[:5]:
        title = r.get("title", "Unbekannt")
        score = r.get("score", 0)
        snippet = r.get("snippet", "") or r.get("text", "")
        context_parts.append(f"- [{title}] (Score: {score}): {snippet[:200]}")

    context = "\n".join(context_parts)

    prompt = (
        f"Du bist ein Wissens-Assistent. Der User liest gerade: '{current_title}'.\n"
        f"Inhalt: {current_content}\n\n"
        f"Relevante Infos aus anderen Tabs:\n{context}\n\n"
        f"Fasse in 2-3 kurzen Sätzen zusammen, WIE diese Infos zum aktuellen Tab passen. "
        f"Sei konkret und nützlich. Antworte auf Deutsch."
    )

    try:
        result = subprocess.run(
            ["hermes", "chat", "-Q", "-q", prompt, "-t", ""],
            capture_output=True,
            text=True,
            timeout=20,
        )
        summary = result.stdout.strip()
        if not summary or result.returncode != 0:
            stderr = result.stderr.strip()
            summary = (
                f"Zusammenfassung fehlgeschlagen: {stderr}"
                if stderr
                else "Zusammenfassung fehlgeschlagen."
            )
    except subprocess.TimeoutExpired:
        summary = "Timeout: Hermes antwortet zu langsam."
    except FileNotFoundError:
        summary = "Hermes/Jarvis nicht installiert."
    except Exception as e:
        summary = f"Hermes-Fehler: {str(e)}"

    return {"summary": summary}


@app.get("/debug/indexed")
def debug_index():
    if collection.count() == 0:
        return {"docs": []}
    data = collection.get(include=["metadatas", "documents"])
    docs = []
    for i in range(len(data["ids"])):
        meta = data["metadatas"][i]
        doc = data["documents"][i]
        docs.append(
            {
                "id": data["ids"][i],
                "tab_id": meta.get("tab_id", ""),
                "title": meta.get("title", ""),
                "url": meta.get("url", ""),
                "source_quality": meta.get("source_quality", "unknown"),
                "content_len": len(doc),
                "snippet": doc[:120] if len(doc) > 120 else doc,
            }
        )
    return {"total": len(docs), "docs": docs}
