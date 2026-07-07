// samplers: sampler_fw_main, sampler_main, sampler_mytex, sampler_noise_hq, sampler_noise_lq, sampler_noise_mq, sampler_noisevol_lq, sampler_pc_main
// samplers3D: sampler_noisevol_lq
// hasBody: true
// ---- preamble ----


// ---- body ----

  vec2 uv2 = vec2(uv);
  ret = tex2D(sampler_main, uv2).xyz;
  ret += GetBlur1(uv2)*0.001;
  ret += GetBlur2(uv2)*0.001;
  ret += GetBlur3(uv2)*0.001;
  ret += tex2D(sampler_noise_lq, uv2*texsize.xy).xyz*0.001;
  ret += tex2D(sampler_noise_mq, uv2).xyz*0.001;
  ret += tex2D(sampler_noise_hq, uv2).xyz*0.001;
  ret += tex3D(sampler_noisevol_lq, vec3(uv2,0.5)).xyz*0.001;
  ret += tex2D(sampler_fw_main, uv2).xyz*0.001;
  ret += tex2D(sampler_pc_main, uv2).xyz*0.001;
  ret += tex2D(sampler_mytex, uv2).xyz*0.001;
  ret += (rand_frame.xyz + rand_preset.xyz)*0.001;
  ret += _qa.xyz*0.001;
  ret += roam_cos.xyz*0.001;
  ret += lum(ret)*0.001;
  ret *= hue_shader;
