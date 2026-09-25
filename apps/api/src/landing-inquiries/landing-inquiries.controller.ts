import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { landingInquiryClientIp } from "./landing-inquiry-client-ip";
import type { LandingInquiryInput } from "./landing-inquiry.dto";
import { LandingInquiriesService } from "./landing-inquiries.service";

@Controller("landing/inquiries")
export class LandingInquiriesController {
  constructor(private readonly inquiries: LandingInquiriesService) {}

  @Post("/")
  @HttpCode(201)
  submit(@Body() input: LandingInquiryInput, @Req() request: Parameters<typeof landingInquiryClientIp>[0]) {
    return this.inquiries.submit(input, landingInquiryClientIp(request));
  }
}
