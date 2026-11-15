# HypeConnect 제휴 제안서 (deck as code)

업체(혼술바·소셜링 파티 점주)에게 보낼 제안서. 내용은 텍스트(YAML), 디자인은 코드(`build.py`)로 나눠 두고
**두 사람이 기능 개발하듯 브랜치 → PR → 리뷰 → 병합**으로 함께 다듬는다.

```
proposal/
├── slides/          # 슬라이드 1장 = YAML 1개. 파일 이름 순서 = 슬라이드 순서
│   ├── 01-cover.yaml
│   ├── 02-problem.yaml
│   └── ...
├── build.py         # 레이아웃·브랜드 색·글꼴 (디자인 담당)
└── dist/            # 빌드 결과 .pptx (git에 올리지 않음)
```

## 빌드

```bash
python3 -m venv .venv && .venv/bin/pip install -r proposal/requirements.txt
.venv/bin/python proposal/build.py   # → proposal/dist/HypeConnect-제휴제안서.pptx
```

PR을 열면 GitHub Actions(`proposal` 워크플로)가 같은 .pptx를 빌드해 **Artifacts**에 올린다.
리뷰어는 로컬 빌드 없이 PR 화면에서 받아 PowerPoint로 열어 보면 된다.

## 슬라이드 고치기

YAML의 `layout`이 슬라이드 모양을 정한다. 쓸 수 있는 레이아웃:
`cover` `cards` `statement` `flow` `stat` `grid` `compare` `mission` `steps` `closing`

- 줄을 바꾸려면 `\n`을 넣는다. PowerPoint는 한글을 글자 단위로 줄바꿈하므로, 단어가 잘리면 `\n`으로 직접 끊는다.
- 발표자 메모는 `notes:`에 쓴다.
- 새 슬라이드는 번호 사이에 파일을 추가한다(예: `05a-case.yaml`). 번호를 다시 매기지 않아도 순서가 유지되고, 다른 사람 PR과 충돌하지 않는다.
- 새 모양이 필요하면 `build.py`에 함수를 추가하고 `LAYOUTS`에 등록한다.

## 두 사람이 함께 쓰는 방법

| 개발 | 제안서 |
|---|---|
| 이슈 | 아이디어·수정 요청 ("가격 슬라이드에 사례 추가") |
| 브랜치 | `proposal/<주제>` 예: `proposal/pricing-example` |
| 커밋 | 슬라이드 단위 (`proposal: 05 가격 예시 문구 수정`) |
| PR | 변경 이유 + 빌드된 .pptx 확인 |
| 리뷰 | 문장에 줄 단위 코멘트, GitHub "Suggest changes"로 대안 문구 제안 |
| 병합 | 둘 다 OK하면 squash 병합 → `main`이 최신 확정본 |
| 릴리스 | 업체에 보낸 버전에 태그 (`proposal-v1.0-업체명`) |

권장 역할 분담(겹치지 않게):
- **A — 내용**: `slides/*.yaml` 문장, 숫자, 흐름
- **B — 디자인/구조**: `build.py` 레이아웃, 새 슬라이드 형식

같은 슬라이드를 동시에 고치지 않도록, 작업 전에 이슈에 "05 내가 잡음"처럼 남긴다.
업체별 맞춤본은 `main`에서 브랜치를 따서 해당 업체 정보만 바꾸고 태그로 남긴다.

## 내용 근거

수수료·상태 흐름·방문 인증·노쇼 규칙은 웹 저장소 `SPECIFICATION.md`(1장·5장)와
이 저장소 `docs/` 문서 기준이다. 규칙이 바뀌면 제안서 문구도 같이 고친다.
