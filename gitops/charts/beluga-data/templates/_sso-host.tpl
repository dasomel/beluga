{{- /*
beluga.ssoHost: sso.yaml 엔드포인트 host(라벨) -> <label>.<baseDomain> FQDN.
입력: dict "host" <라벨> "root" <최상위 컨텍스트 $>
D-DOM-2: sso.yaml은 도메인을 선언하지 않는다(도메인의 단일 원천은 .Values.baseDomain).
FQDN이 박혀 있으면(점 포함) 환경별 도메인과 어긋나므로 렌더를 실패시킨다.
Escape hatch: 없음(의도). 새 환경은 baseDomain 값만 바꾼다.
*/ -}}
{{- define "beluga.ssoHost" -}}
{{- if contains "." .host -}}
{{- fail (printf "sso.yaml endpoint host %q must be a bare label (the domain comes from baseDomain)" .host) -}}
{{- end -}}
{{- printf "%s.%s" .host .root.Values.baseDomain -}}
{{- end -}}
