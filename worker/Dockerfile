# re-animator 입력단 워커 — sharp(libvips) 로 컷 분할·추출.
# (ffmpeg 는 M7 합성 워커에서 추가. M1 은 이미지 연산만.)
FROM node:20-slim

# sharp 는 prebuilt libvips 를 번들하므로 별도 시스템 패키지 불필요.
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.mjs"]
