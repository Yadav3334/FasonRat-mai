package com.fason.app.features.gps

import retrofit2.http.Body
import retrofit2.http.POST
import retrofit2.http.Url
import retrofit2.Response

interface LocationApi {
    @POST
    suspend fun sendLocation(@Url url: String, @Body payload: LocationPayload): Response<Unit>
}
