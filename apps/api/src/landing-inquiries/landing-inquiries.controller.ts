import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import type { LandingInquiryInput } from "./landing-inquiry.dto";
import { LandingInquiriesService } from "./landing-inquiries.service";

@Controller("landing/inquiries")
export class LandingInquiriesController {
  constructor(private readonly inquiries: LandingInquiriesService) {}

  @Post("/")
  @HttpCode(201)
  submit(@Body() input: LandingInquiryInput, @Req() request: { ip?: string }) {
    return this.inquiries.submit(input, request.ip || "unknown");
  }
}
