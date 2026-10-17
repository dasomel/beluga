{{- /*
D-MSSO-14: allowedGroups 소비자 — gateway-oidc 라우트에 붙는 serverless-post-function(access 단계).
입력: allowedGroups 리스트. 그룹명은 [a-z0-9-]만 허용(Lua 리터럴 주입 방지, sso.yaml 검증과 동일 규칙).
Reason: openid-connect는 rewrite 단계에서 클라이언트가 보낸 X-Userinfo를 지우고(set_userinfo_header=true면)
        세션 인증 성공 후 base64(JSON userinfo)로 다시 채운다. 이 함수는 그 값만 신뢰하고 읽은 직후 헤더를 지운다.
        헤더/디코드/groups 클레임이 없으면 403(fail-closed). groups는 'admins'/'/admins' 양쪽을 정규화해 비교한다.
Cost: 세션이 userinfo를 캐시하므로 그룹 회수는 세션 만료(absolute_timeout)까지 지연된다. Lua가 게이트웨이 설정에 남는다.
Escape hatch: sso.yaml에서 allowedGroups 제거(검사 없음) 또는 mode: none.
*/ -}}
{{- define "beluga.ssoGroupGuard" -}}
{{- range . }}
{{- if not (regexMatch "^[a-z0-9-]+$" .) }}
{{- fail (printf "sso.yaml allowedGroups: invalid group name %q (allowed: [a-z0-9-])" .) }}
{{- end }}
{{- end }}
- name: serverless-post-function
  enable: true
  config:
    phase: access
    functions:
      - |
        return function(conf, ctx)
          local core = require("apisix.core")
          local allowed = {
        {{- range . }}
            [{{ . | quote }}] = true,
        {{- end }}
          }
          local raw = core.request.header(ctx, "X-Userinfo")
          core.request.set_header(ctx, "X-Userinfo", nil)
          local ok = false
          if raw and raw ~= "" then
            local text = ngx.decode_base64(raw)
            if text then
              local parsed, info = pcall(core.json.decode, text)
              if parsed and type(info) == "table" and type(info.groups) == "table" then
                for _, g in ipairs(info.groups) do
                  if type(g) == "string" and allowed[(g:gsub("^/", ""))] then
                    ok = true
                    break
                  end
                end
              end
            end
          end
          if not ok then
            return 403, { message = "Forbidden: group not allowed" }
          end
        end
{{- end -}}
