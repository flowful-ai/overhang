FROM continuumio/miniconda3:26.7.1-1

WORKDIR /app

# Install system dependencies for CadQuery (OCP)
# libgl1-mesa-glx was removed in Debian trixie, replaced by libgl1
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglu1-mesa \
    && rm -rf /var/lib/apt/lists/*

# Install CadQuery via conda. Both are pinned: an unpinned cadquery lets the
# solver silently settle on an old release that still fits the Python pin
# (cadquery 2.8.0 on conda-forge needs Python >=3.11). Keep these in sync with
# the worker job in .github/workflows/test.yml. A dedicated env is used because
# the base env of recent miniconda images ships a newer Python that cannot be
# downgraded in place.
RUN conda create -n cadquery --override-channels -c conda-forge python=3.12 cadquery=2.8.0 -y \
    && conda clean -afy
ENV PATH=/opt/conda/envs/cadquery/bin:$PATH

# Install Python dependencies. Pins live in requirements.txt for reproducible
# builds; copied on its own first so this layer is cached unless deps change.
# Test-only deps (pytest, httpx) live in requirements-dev.txt and are not
# installed here so they don't ship in the production image.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create non-root user and ensure writable home for runtime caches
RUN useradd -m -u 1001 appuser && \
    mkdir -p /home/appuser/.cache && \
    chown -R appuser:appuser /home/appuser

# Copy application code
COPY --chown=appuser:appuser . .

USER appuser

# Expose port
EXPOSE 8000

# Run the application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
