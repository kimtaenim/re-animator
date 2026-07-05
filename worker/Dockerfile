# re-animator 워커 — sharp(libvips) 컷 분할·추출 + ffmpeg 합성(영상 이어붙이기).
FROM node:20-slim

# ffmpeg: 5단계 합성(concat·전환·인코딩). sharp 는 prebuilt libvips 번들이라 별도 불필요.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.mjs"]
