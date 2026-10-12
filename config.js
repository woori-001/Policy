/* 상부정책 관리 — 접속 설정
   Supabase 주소와 "공개(publishable)" 키입니다. 브라우저에 공개돼도 되는 값입니다.
   (테이블은 RLS 로 막혀 있고, 모든 읽기/쓰기는 Edge Function 이 로그인·명단을 확인한 뒤에만 합니다) */
window.POLICY_CONFIG = {
  url: "https://omdyyvqkxxigilxjysbz.supabase.co",
  key: "sb_publishable_g41wwhIMN19UchPheU9Vvg_lAHjnZNf"
};
