export const CLIENT_PHOTO_ACCEPT = 'image/*';

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1600;
const OUTPUT_MIME = 'image/webp';

export function validarFotoCliente(file) {
  if (!file) return 'Selecione uma foto.';
  if (!file.size) return 'A imagem selecionada está vazia.';
  if (file.size > MAX_SOURCE_BYTES) {
    return 'A imagem original é muito grande. Use um arquivo de até 50 MB.';
  }

  const mime = String(file.type || '').toLowerCase();
  if (mime && !mime.startsWith('image/')) {
    return 'O arquivo selecionado não é uma imagem.';
  }
  if (mime === 'image/svg+xml') {
    return 'Use uma foto em formato de imagem raster, como JPG, PNG ou WebP.';
  }

  return null;
}

function carregarImagem(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release: () => URL.revokeObjectURL(objectUrl),
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Não foi possível abrir esta imagem. Tente JPG, PNG, WebP, GIF, BMP ou AVIF.'));
    };
    image.src = objectUrl;
  });
}

async function decodificarImagem(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // O elemento Image abre alguns formatos que createImageBitmap nao suporta.
    }
  }

  return carregarImagem(file);
}

function canvasParaBlob(canvas, mime, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

async function codificarCanvas(canvas, quality) {
  const webp = await canvasParaBlob(canvas, OUTPUT_MIME, quality);
  if (webp?.type === OUTPUT_MIME) return webp;
  return canvasParaBlob(canvas, 'image/jpeg', quality);
}

function desenharImagem(canvas, context, source, width, height) {
  canvas.width = width;
  canvas.height = height;
  context.clearRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
}

function criarNomeArquivo(nomeOriginal, mime) {
  const base = String(nomeOriginal || 'foto-cliente')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'foto-cliente';
  const extension = mime === 'image/webp' ? 'webp' : 'jpg';
  return `${base}.${extension}`;
}

export async function prepararFotoCliente(file) {
  const erro = validarFotoCliente(file);
  if (erro) throw new Error(erro);

  const decoded = await decodificarImagem(file);
  try {
    if (!decoded.width || !decoded.height) {
      throw new Error('A imagem selecionada não possui dimensões válidas.');
    }

    const initialScale = Math.min(
      1,
      MAX_IMAGE_SIDE / Math.max(decoded.width, decoded.height)
    );
    let width = Math.max(1, Math.round(decoded.width * initialScale));
    let height = Math.max(1, Math.round(decoded.height * initialScale));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      throw new Error('Não foi possível preparar a foto neste dispositivo.');
    }

    const qualityLevels = [0.88, 0.78, 0.68, 0.58];
    let output = null;

    for (let resizeAttempt = 0; resizeAttempt < 3; resizeAttempt += 1) {
      desenharImagem(canvas, context, decoded.source, width, height);

      for (const quality of qualityLevels) {
        output = await codificarCanvas(canvas, quality);
        if (output && output.size <= MAX_OUTPUT_BYTES) break;
      }

      if (output && output.size <= MAX_OUTPUT_BYTES) break;
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
    }

    if (!output) {
      throw new Error('Não foi possível converter a imagem selecionada.');
    }
    if (output.size > MAX_OUTPUT_BYTES) {
      throw new Error('Não foi possível reduzir a foto para o tamanho necessário.');
    }

    return new File(
      [output],
      criarNomeArquivo(file.name, output.type),
      { type: output.type, lastModified: Date.now() }
    );
  } finally {
    decoded.release();
  }
}

export function formatarTamanhoFoto(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
