{{/*
D-KCTHEME-2: Beluga 로그인 테마 파일 ↔ ConfigMap 키 매핑. ConfigMap 키에는 "/"를 쓸 수 없어 "__"로 치환하고,
Deployment의 volume items가 같은 매핑으로 원래 경로(login/resources/css/beluga.css 등)를 복원한다.
Reason: files/keycloak-theme/beluga/ 트리를 그대로 마운트(readOnlyRootFilesystem 유지); Cost: 파일 추가 시 재렌더만 필요(목록 하드코딩 없음);
Escape hatch: 테마가 커지면 init 컨테이너/이미지 번들로 전환.
*/}}
{{- define "beluga.keycloakTheme.key" -}}
{{- . | trimPrefix "files/keycloak-theme/beluga/" | replace "/" "__" -}}
{{- end }}

{{- define "beluga.keycloakTheme.items" -}}
{{- range $path, $_ := .Files.Glob "files/keycloak-theme/beluga/**" }}
- key: {{ include "beluga.keycloakTheme.key" $path | quote }}
  path: {{ $path | trimPrefix "files/keycloak-theme/beluga/" | quote }}
{{- end }}
{{- end }}

{{- define "beluga.keycloakTheme.checksum" -}}
{{- $all := "" }}
{{- range $path, $_ := .Files.Glob "files/keycloak-theme/beluga/**" }}
{{- $all = print $all $path ($.Files.Get $path) }}
{{- end }}
{{- $all | sha256sum | trunc 16 -}}
{{- end }}
