-- 본문 칸을 jsonb → json 으로 바꿉니다.
--   jsonb 는 객체 키 순서를 바꿔 저장합니다({splitA,rows} → {rows,splitA}).
--   예전 시트(JSON 글자)와 같은 순서로 돌려받아야 "무엇이 바뀌었나" 비교(등급 차감표 비밀번호 범위 · 이력 문구)가 맞습니다.
--   json 은 받은 글자를 그대로 보관합니다 (\u0000 같은 글자도 거부하지 않음).
alter table public.pol_kv          alter column value type json using value::json;
alter table public.pol_policy      alter column body  drop default, alter column body  type json using body::json,  alter column body  set default '{}'::json;
alter table public.pol_draft       alter column body  drop default, alter column body  type json using body::json,  alter column body  set default '{}'::json;
alter table public.pol_hist        alter column body  drop default, alter column body  type json using body::json,  alter column body  set default '{}'::json;
alter table public.pol_trash       alter column data  type json using data::json;
alter table public.pol_grades      alter column cfg   type json using cfg::json;
alter table public.pol_grades_hist alter column cfg   type json using cfg::json;
alter table public.pol_psheet      alter column tpl   type json using tpl::json;
alter table public.pol_psheet_hist alter column snap  type json using snap::json;
